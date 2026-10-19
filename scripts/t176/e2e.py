"""T-176 end to end: Uni asks, the app seals, the plugin stores; the dummy value is only in the 0600 file.

Everything is throwaway: a relay on 127.0.0.1 (scripts/t176/relay.py, SQLite DB), fresh random keys for
Uni, the owner and Mallory, and a work dir under $TMPDIR. The plugin half is the real uni-secrets Runtime;
the app half is the real uni-core code (examples/secret_send.rs: store → request → seal → publish).
Logs are written the way the gateway writes them, with websockets' DEBUG frame logging on, and a
simulated session transcript gets everything the model would see. Prints counts and booleans only.

Run: scripts/t176/e2e.sh   (builds the example, runs this with Hermes' venv python)
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

ROOT = Path(__file__).resolve().parents[2]
# The uni-secrets plugin is private: staged in the git-ignored hermes-plugin/ or named by UNI_SECRETS_PLUGIN.
PLUGIN = Path(os.environ.get("UNI_SECRETS_PLUGIN") or ROOT / "hermes-plugin" / "uni-secrets")
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import nostr_crypto as nc  # noqa: E402
from relay import Relay  # noqa: E402
from runtime import Runtime  # noqa: E402

APP = ROOT / "target" / "debug" / "examples" / "secret_send"
CHANNEL = "7a1f3c52-0b6e-4d1f-9a7e-2f0c5d9b8e41"
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
        except (OSError, ValueError):  # a file not written yet
            pass
        time.sleep(step)
    return False


def write_failure_checks(work, name, res, pending_file, relay_rows, transcript) -> None:
    """With the secret dir read-only: the delivery fails, consumes nothing, and the agent hears nothing yet."""
    check("a failed write is logged as failed", wait_for(
        lambda: f"could not store {name}: PermissionError" in (work / "logs" / "gateway.log").read_text(), 10))
    check("the request and its one-time key survive the failed write", res["request_event"] in pending_file.read_text())
    check("Uni told the room it will keep trying", wait_for(lambda: any(
        "couldn't finish storing it" in e["content"] for e in relay_rows(9))))
    check("the agent heard nothing yet", "[uni-secrets] Secret" not in transcript.read_text())


def main() -> int:
    keep = "--keep" in sys.argv
    work = Path(tempfile.mkdtemp(prefix="t176-e2e-", dir=os.environ.get("TMPDIR")))
    (work / "logs").mkdir()
    (work / "sessions").mkdir()
    dummy = f"t176-dummy-{secrets.token_hex(12)}"
    mallory_value = f"t176-dummy-mallory-{secrets.token_hex(8)}"
    name = "tailscale-api"

    # Gateway-style logging: everything (relay client frames included) to logs/gateway.log at DEBUG.
    handler = logging.FileHandler(work / "logs" / "gateway.log")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.DEBUG, handlers=[handler], force=True)
    gw = logging.getLogger("gateway.run")
    transcript = work / "sessions" / "transcript.jsonl"

    def to_model(role: str, content) -> None:
        """What enters the model's context: the transcript line, and the gateway's inbound log line."""
        if role == "user":
            gw.info("inbound message: platform=buzz msg=%r", str(content)[:80])
        with transcript.open("a") as f:
            f.write(json.dumps({"role": role, "content": content}) + "\n")

    uni_sk, owner_sk, mallory_sk = (secrets.token_bytes(32) for _ in range(3))
    uni, owner, mallory = (nc.pubkey_hex(k) for k in (uni_sk, owner_sk, mallory_sk))

    # The relay runs on its own loop in a thread.
    relay = Relay(work / "relay-events.db", members={uni, owner, mallory})
    rloop = asyncio.new_event_loop()
    threading.Thread(target=rloop.run_forever, daemon=True).start()
    url = asyncio.run_coroutine_threadsafe(relay.start(), rloop).result(5)

    rt = Runtime(relay_url=url, uni_sk=uni_sk, allowed_senders={owner}, secret_dir=work / "secrets",
                 state_dir=work / "hermes-home" / "uni-secrets", notify=lambda ch, text, who: to_model("user", text),
                 retry_s=1)
    rt.start()
    check("plugin inbox authenticated to the relay", rt.wait_ready())

    def app(sk: bytes, mode: str, value: str = "") -> subprocess.CompletedProcess:
        env = {**os.environ, "UNI_NSEC": sk.hex(), "UNI_SECRET_REQUESTERS": uni, "UNI_NO_KEYRING": "1",
               "RUST_LOG": "trace"}
        with (work / "logs" / "app.log").open("a") as log:
            return subprocess.run([str(APP), url, CHANNEL, mode], input=value, text=True, env=env,
                                  stdout=log, stderr=subprocess.STDOUT, timeout=60)

    # 1. The owner asks for something that needs a token; Uni calls secret_request.
    to_model("user", "Robin: can you list my tailnet devices?")
    args = {"channel": CHANNEL, "name": name, "label": "Tailscale API token",
            "purpose": "List the devices on the tailnet.", "keep_days": 30}
    to_model("assistant", {"tool_call": "secret_request", "args": args})
    res = json.loads(rt.request(args))
    to_model("tool", res)
    check("secret_request posted the request", res.get("ok") is True)
    pending_file = work / "hermes-home" / "uni-secrets" / "pending.json"
    check("pending request (with one-time key) is mode 600", stat.S_IMODE(pending_file.stat().st_mode) == 0o600)

    def relay_rows(kind: int):
        return [json.loads(r[0]) for r in relay.db.execute("SELECT raw FROM events WHERE kind=?", (kind,))]

    # 2. Mallory (a relay member, not an allowed sender) answers first: ignored, nothing stored.
    p = app(mallory_sk, "send", mallory_value)
    check("app sealed and published Mallory's answer", p.returncode == 0)
    time.sleep(1.0)
    check("Mallory's answer was opened and refused (sender not allowed)", wait_for(
        lambda: "is not allowed" in (work / "logs" / "gateway.log").read_text(), 10))
    check("Mallory's value was not stored", not (work / "secrets" / name).exists())

    # 3. The owner answers through the app path, while uni can't write its secret dir (a full or read-only disk).
    secret_dir = work / "secrets"
    disk_fails = os.geteuid() != 0  # root ignores directory permissions
    if disk_fails:
        secret_dir.chmod(0o500)
    else:
        print("SKIP  the write-failure checks: running as root, chmod can't make the write fail")
    p = app(owner_sk, "send", dummy + "\n")
    check("app sealed and published the owner's answer", p.returncode == 0, f"exit {p.returncode}")
    target = secret_dir / name
    if disk_fails:
        write_failure_checks(work, name, res, pending_file, relay_rows, transcript)
    secret_dir.chmod(0o700)  # the disk is back; the runtime's retry stores the same wrap
    check("plugin stored the secret on retry", wait_for(lambda: target.exists() and json.loads(
        (work / "hermes-home" / "uni-secrets" / "index.json").read_text()).get(name)))
    check("secret file is mode 600", target.exists() and stat.S_IMODE(target.stat().st_mode) == 0o600)
    check("secret file holds exactly the value", target.exists() and target.read_text() == dummy, f"{len(dummy)} chars")
    check("one-time key is gone (request consumed)", res["request_event"] not in pending_file.read_text())
    to_model("assistant", {"tool_call": "terminal", "args": {
        "command": f'curl -s -H "Authorization: Bearer $(cat {target})" https://api.tailscale.com/api/v2/tailnet/-/devices'}})

    receipts = lambda: [e for e in relay_rows(9) if "```uni-secret-stored" in e["content"]]
    check("Uni posted a 'stored' receipt in the room", wait_for(lambda: len(receipts()) == 1, 10))
    wraps = relay_rows(1059)
    check("relay holds the two answers only as gift wraps", len(wraps) == 2 and all(
        w["pubkey"] not in (owner, mallory) for w in wraps), "signed by throwaway keys")
    check("the agent's note names the handle (simulated transcript)", f"uni-secret:{name}" in transcript.read_text())

    # 4. Replaying a handled wrap does nothing.
    out = rt._run(rt._on_wrap(wraps[-1]))
    check("a replayed wrap is ignored", out.status == "ignored" and out.detail == "already handled", out.detail)

    # 5. A secret pasted into chat is dropped before the model (pre_gateway_dispatch).
    pasted = f"here you go tskey-api-{secrets.token_hex(10)}"
    verdict = rt.guard(pasted, CHANNEL)
    check("pasted token is skipped by the guard", verdict and verdict.get("action") == "skip")
    if not verdict:
        to_model("user", pasted)

    # 6. Where the dummy is: grep every byte the run wrote (relay DB, logs, transcript, state, app store).
    time.sleep(0.5)
    asyncio.run_coroutine_threadsafe(asyncio.sleep(0), rloop).result(5)
    relay.db.commit()
    needle = dummy.encode()
    hits = sorted(str(f.relative_to(work)) for f in work.rglob("*") if f.is_file() and needle in f.read_bytes())
    check("dummy is absent from the relay DB", not any(h.startswith("relay-events.db") for h in hits))
    check("dummy is absent from the harness and plugin logs", not any(h.startswith("logs/") for h in hits))
    check("dummy is absent from the simulated transcript", not any(h.startswith("sessions/") for h in hits))
    check("dummy is absent from plugin state", not any(h.startswith("hermes-home/") for h in hits))
    check("dummy is in exactly one file: the 600-mode secret", hits == [f"secrets/{name}"], ", ".join(hits))
    check("Mallory's value is nowhere", not any(mallory_value.encode() in f.read_bytes()
                                                 for f in work.rglob("*") if f.is_file()))
    check("pasted token is absent from logs and transcript", not any(
        pasted.split()[-1].encode() in f.read_bytes() for f in [transcript, work / "logs" / "gateway.log"]))
    gw_log = (work / "logs" / "gateway.log").read_text()
    check("the log did record the traffic (frames, wraps)", "uni_secrets" in gw_log and "gift wrap" in gw_log
          and "websockets" in gw_log)

    # 7. The owner forgets it from the app: the file goes, and Uni says so.
    p = app(owner_sk, "forget")
    check("app sealed and published a forget", p.returncode == 0)
    check("plugin deleted the secret", wait_for(lambda: not target.exists()))
    check("Uni posted a 'forgotten' receipt", wait_for(lambda: any(
        "```uni-secret-forgotten" in e["content"] for e in relay_rows(9))))

    rt.stop()
    asyncio.run_coroutine_threadsafe(relay.stop(), rloop).result(5)
    failed = [n for n, ok, _ in results if not ok]
    (Path(os.environ.get("T176_REPORT", work / "e2e-report.json"))).write_text(
        json.dumps({"passed": len(results) - len(failed), "failed": failed, "work": str(work)}, indent=1))
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed · work dir {work}"
          f"{' (kept)' if keep else ' (removed)'}")
    if not keep:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
