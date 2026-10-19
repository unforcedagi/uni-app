"""T-176 at Hermes' own boundaries: the plugin loaded by the real loader, the real Buzz adapter's event filter,
the real ``pre_gateway_dispatch`` dispatch and the real ``inject_message`` path, against a throwaway relay.

e2e.py drives the plugin's Runtime directly and writes a simulated transcript. This run goes through the
hermes-agent code itself (imported read only from a checkout, nothing written there: bytecode is off) with
HERMES_HOME in a temp dir:

- ``hermes_cli.plugins.discover_plugins`` loads hermes-plugin/uni-secrets from $HERMES_HOME/plugins, enabled and
  allowed to inject in config.yaml, with throwaway keys supplied as env secrets;
- the agent's ``secret_request`` goes through ``tools.registry.registry.dispatch``;
- the app half (examples/secret_send.rs) seals the dummy value; the resulting kind-1059 wrap is handed to the real
  ``BuzzAdapter._handle_event``, which must drop it before ``handle_message``;
- the "stored" note reaches the gateway through the real ``PluginContext.inject_message``; the injector at the
  end of that path (the gateway's ``_schedule_plugin_message_injection`` in production) records what it gets;
- ``GatewayRunner._hm_pre_gateway_dispatch_hook`` runs the real hook dispatch on a pasted token.

Then every file under the work dir (HERMES_HOME with its logs, the relay DB, the root log at DEBUG) is searched
for the dummy. Not covered here: the runner's turn after the hook (session store, model call), Tauri IPC,
clipboard history and crash dumps (T-176 design note §6).

Run: scripts/t176/e2e.sh (after e2e.py), or directly with Hermes' venv python -B.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
# The uni-secrets plugin is private: staged in the git-ignored hermes-plugin/ or named by UNI_SECRETS_PLUGIN.
PLUGIN = Path(os.environ.get("UNI_SECRETS_PLUGIN") or ROOT / "hermes-plugin" / "uni-secrets")
HERMES_AGENT = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / "REPOS" / "hermes-agent"))
APP = ROOT / "target" / "debug" / "examples" / "secret_send"
CHANNEL = "5c2e8a10-3f4b-4c6d-8e9f-0a1b2c3d4e5f"
PLUGIN_ID = "uni-secrets"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, note: str = "") -> None:
    results.append((name, bool(ok), note))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  · ' + note) if note else ''}", flush=True)


def wait_for(pred, timeout=20.0, step=0.1) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if pred():
                return True
        except (OSError, ValueError):
            pass
        time.sleep(step)
    return False


def main() -> int:
    keep = "--keep" in sys.argv
    work = Path(tempfile.mkdtemp(prefix="t176-gw-", dir=os.environ.get("TMPDIR")))
    home = work / "hermes-home"
    dummy = f"t176-dummy-{secrets.token_hex(12)}"
    name = "tailscale-api"

    # Throwaway relay and keys (scripts/t176/relay.py), before the plugin loads: it connects at register().
    sys.path.insert(0, str(PLUGIN))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import nostr_crypto as nc
    from relay import Relay

    uni_sk, owner_sk = secrets.token_bytes(32), secrets.token_bytes(32)
    uni, owner = nc.pubkey_hex(uni_sk), nc.pubkey_hex(owner_sk)
    relay = Relay(work / "relay-events.db", members={uni, owner})
    rloop = asyncio.new_event_loop()
    threading.Thread(target=rloop.run_forever, daemon=True).start()
    url = asyncio.run_coroutine_threadsafe(relay.start(), rloop).result(5)

    # HERMES_HOME with the plugin installed and enabled; secrets come from the env (agent.secret_scope falls back).
    (home / "plugins").mkdir(parents=True)
    shutil.copytree(PLUGIN, home / "plugins" / PLUGIN_ID,
                    ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (home / "config.yaml").write_text(f"plugins:\n  enabled: [{PLUGIN_ID}]\n  entries:\n    {PLUGIN_ID}:\n"
                                      f"      allow_gateway_injection: true\n")
    os.environ.update({"HERMES_HOME": str(home), "BUZZ_PRIVATE_KEY": uni_sk.hex(), "BUZZ_RELAY_URL": url,
                       "BUZZ_ALLOWED_USERS": owner, "UNI_SECRETS_DIR": str(work / "secrets")})
    os.environ.pop("HERMES_SAFE_MODE", None)
    (work / "logs").mkdir()
    handler = logging.FileHandler(work / "logs" / "root.log")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.DEBUG, handlers=[handler], force=True)

    sys.path.insert(0, str(HERMES_AGENT))
    import gateway.run as gw_run  # noqa: F401  (the gateway's own import-time setup, as in production)
    from gateway.config import Platform
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    from hermes_cli import plugins as hp
    from plugins.platforms.buzz import adapter as buzz
    from tools.registry import registry

    # 1. The real loader.
    hp.discover_plugins(force=True)
    manager = hp.get_plugin_manager()
    mod = next((m for k, m in sys.modules.items() if k.startswith("hermes_plugins.") and hasattr(m, "_RT")
                and getattr(m, "__file__", "").startswith(str(home))), None)
    check("Hermes' loader loaded uni-secrets from $HERMES_HOME/plugins", mod is not None)
    if mod is None:
        return finish(work, keep, relay, rloop)
    check("its inbox authenticated to the relay", mod._RT is not None and mod._RT.wait_ready())
    check("pre_gateway_dispatch is registered", hp.has_hook("pre_gateway_dispatch"))
    injected: list[dict] = []
    manager.set_gateway_message_injector(object(), lambda **kw: injected.append(kw) or True)

    # 2. The agent asks, through the real tool dispatch.
    args = {"channel": CHANNEL, "name": name, "label": "Tailscale API token",
            "purpose": "List the devices on the tailnet.", "keep_days": 30}
    out = registry.dispatch("secret_request", args)
    res = json.loads(out) if isinstance(out, str) else out
    check("secret_request ran through tools.registry", res.get("ok") is True, str(res.get("error", ""))[:80])

    # 3. The app seals the dummy (the real uni-core path) and publishes the wrap.
    env = {**os.environ, "UNI_NSEC": owner_sk.hex(), "UNI_SECRET_REQUESTERS": uni, "UNI_NO_KEYRING": "1",
           "RUST_LOG": "trace"}
    with (work / "logs" / "app.log").open("a") as log:
        p = subprocess.run([str(APP), url, CHANNEL, "send"], input=dummy + "\n", text=True, env=env,
                           stdout=log, stderr=subprocess.STDOUT, timeout=60)
    check("app sealed and published the answer", p.returncode == 0, f"exit {p.returncode}")
    target = work / "secrets" / name
    check("plugin stored it (0600, exactly the value)", wait_for(lambda: target.exists())
          and stat.S_IMODE(target.stat().st_mode) == 0o600 and target.read_text() == dummy)

    # 4. The real inject path carried only the note.
    check("the stored note reached the gateway injector", wait_for(lambda: len(injected) == 1, 10))
    note = injected[0] if injected else {}
    check("the injected note names the handle", f"uni-secret:{name}" in str(note.get("content")))
    check("the injected note has no value", dummy not in json.dumps(note, default=str))
    check("it is routed to the room's Buzz session", (note.get("origin") or {}).get("platform") == "buzz"
          and (note.get("origin") or {}).get("chat_id") == CHANNEL and note.get("plugin_id") == PLUGIN_ID)

    # 5. The real Buzz adapter drops a kind-1059 before dispatch, even if it were handed one.
    wraps = [json.loads(r[0]) for r in relay.db.execute("SELECT raw FROM events WHERE kind=1059")]
    dispatched: list = []
    adapter = object.__new__(buzz.BuzzAdapter)

    async def record(event):
        dispatched.append(event)
    adapter.handle_message = record
    for w in wraps:
        asyncio.run(adapter._handle_event(CHANNEL, {"seen": {}, "last_ts": 0}, w))
    check("the Buzz adapter never subscribes to kind 1059", 1059 not in buzz._DISPATCH_KINDS,
          f"dispatch kinds {sorted(buzz._DISPATCH_KINDS)}")
    check("the Buzz adapter drops the real wrap before handle_message", len(wraps) == 1 and dispatched == [])

    # 6. The real pre_gateway_dispatch dispatch: a pasted token is dropped before auth and the model.
    runner = object.__new__(gw_run.GatewayRunner)
    pasted = f"here you go tskey-api-{secrets.token_hex(10)}"

    def dispatch(text: str, platform: str = "buzz"):
        src = SessionSource(platform=Platform(platform), chat_id=CHANNEL, chat_type="group", user_id=owner)
        return asyncio.run(runner._hm_pre_gateway_dispatch_hook(MessageEvent(text=text, source=src,
                                                                             message_id="m1"), src))
    check("a pasted token is dropped by the real hook dispatch", dispatch(pasted) is None)
    check("an ordinary message passes", dispatch("thanks, that worked") is not None)

    # 7. Where the dummy is: every byte under the work dir.
    time.sleep(0.5)
    relay.db.commit()
    needle = dummy.encode()
    hits = sorted(str(f.relative_to(work)) for f in work.rglob("*") if f.is_file() and needle in f.read_bytes())
    check("dummy is in exactly one file: the 600-mode secret", hits == [f"secrets/{name}"], ", ".join(hits))
    check("the pasted token is in no log", not any(pasted.split()[-1].encode() in f.read_bytes()
                                                    for f in work.rglob("*.log")))
    root_log = (work / "logs" / "root.log").read_text()
    check("the logs did record the run (plugin load, frames, wrap)", "uni_secrets" in root_log
          and "gift wrap" in root_log and "websockets" in root_log)
    return finish(work, keep, relay, rloop, mod)


def finish(work: Path, keep: bool, relay, rloop, mod=None) -> int:
    if mod is not None and mod._RT is not None:
        mod._RT.stop()
    asyncio.run_coroutine_threadsafe(relay.stop(), rloop).result(5)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} gateway-boundary checks passed · work dir {work}"
          f"{' (kept)' if keep else ' (removed)'}")
    if not keep:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if failed or not results else 0


if __name__ == "__main__":
    sys.exit(main())
