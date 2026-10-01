#!/usr/bin/env python3
"""Real Uni/Buzz CLI pairing, with fresh keys and all secret-bearing output private."""
import json
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import shutil
import tomllib
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
BUZZ = Path(os.environ.get("BUZZ_DIR", Path.home() / "Code/buzz"))
PROCESSES = []
UNI_BINARY = None
BUZZ_CLI_MANIFEST = None


def cargo(cwd, *args):
    result = subprocess.run(["cargo", *args], cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        # Build diagnostics have no runtime inputs or keys.
        print(result.stderr)
        raise RuntimeError("build failed")


def toml_value(value):
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{key} = {toml_value(item)}" for key, item in value.items()) + " }"
    return json.dumps(value)


def prepare_cli_manifest(directory):
    """Compile the reference CLI unchanged, with one explicit TLS provider.

    Its standalone manifest currently enables neither rustls provider; WSS then
    panics. This build-only overlay adds ring without editing any Buzz files.
    All existing dependencies and the lockfile come from the reference repo.
    """
    root = tomllib.loads((BUZZ / "Cargo.toml").read_text())
    cli = tomllib.loads((BUZZ / "crates/buzz-pairing-cli/Cargo.toml").read_text())
    manifest = Path(directory) / "Cargo.toml"
    content = ['[workspace]', 'resolver = "2"', '[package]', 'name = "buzz-pairing-cli"']
    for key in ("version", "edition", "rust-version", "license"):
        content.append(f"{key} = {toml_value(root['workspace']['package'][key])}")
    content.extend(['[[bin]]', 'name = "buzz-pair"',
                    'path = ' + json.dumps(str(BUZZ / "crates/buzz-pairing-cli/src/main.rs")), '[dependencies]'])
    for name, dependency in cli["dependencies"].items():
        if isinstance(dependency, dict) and dependency.get("workspace"):
            inherited = root["workspace"]["dependencies"][name]
            dependency = dict(inherited) if isinstance(inherited, dict) else {"version": inherited}
            if "path" in dependency:
                dependency["path"] = str(BUZZ / dependency["path"])
        content.append(f"{name} = {toml_value(dependency)}")
    content.append('rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }')
    manifest.write_text("\n".join(content) + "\n")
    shutil.copyfile(BUZZ / "Cargo.lock", Path(directory) / "Cargo.lock")
    print("NOTICE: reference Buzz CLI uses a temporary ring-enabled TLS manifest; Buzz source files unchanged", flush=True)
    return manifest


class Peer:
    def __init__(self, command, cwd, env):
        self.p = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        PROCESSES.append(self.p)
        self.lines = []
        self.queue = queue.Queue()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.p.stdout:
            self.lines.append(line)
            self.queue.put(line)
        self.queue.put(None)

    def find(self, pattern, timeout=40):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self.queue.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if line is None:
                break
            match = re.search(pattern, line)
            if match:
                return match.group(1)
        phase = "connecting" if any("Connecting to " in line for line in self.lines) else "startup"
        raise RuntimeError(f"peer did not reach expected protocol step ({pattern}); phase={phase}; exit={self.p.poll()}")

    def send(self, value):
        self.p.stdin.write(value + "\n")
        self.p.stdin.flush()

    def finish(self, marker):
        self.p.wait(timeout=40)
        self.reader.join(timeout=2)
        if self.p.returncode or not any(marker in line for line in self.lines):
            raise RuntimeError("peer did not report success")


def uni(mode, env):
    return Peer([str(UNI_BINARY), mode], ROOT, env)


def buzz(mode, env, *args):
    return Peer(["cargo", "run", "--quiet", "--manifest-path", str(BUZZ_CLI_MANIFEST), "--target-dir", str(BUZZ / "target"), "-p", "buzz-pairing-cli", "--", mode, *args], BUZZ, env)


def run_case(number, relay, label):
    print(f"RUN {label} case {number}", flush=True)
    env = os.environ.copy()
    # Strip actual account configuration: this harness only uses freshly random throwaway keys.
    env.pop("UNI_NSEC", None)
    env["UNI_PAIR_KEY"] = secrets.token_hex(32)
    env["UNI_PAIR_RELAY"] = relay
    expected = uni("pubkey", env)
    pubkey = expected.find(r"PUBKEY ([0-9a-f]{64})")
    expected.p.wait(timeout=10)
    with tempfile.TemporaryDirectory(prefix="uni-pair-") as directory:
        if number in (1, 2):
            fifo = Path(directory) / "uri"
            os.mkfifo(fifo, 0o600)
            env["UNI_PAIR_URI_PIPE"] = str(fifo)
            result = queue.Queue()
            def read_uri():
                with fifo.open() as stream:
                    result.put(stream.read())
            threading.Thread(target=read_uri, daemon=True).start()
            source = uni("source", env)
            uri = result.get(timeout=40)
        else:
            source = buzz("source", env, "--relay", relay, "--nsec", env["UNI_PAIR_KEY"])
            uri = source.find(r"(nostrpair://\S+)")
            # Buzz CLI emits its QR before connecting/subscribing. Allow EOSE before target offer.
            time.sleep(4)
        if number == 2:
            target = buzz("target", env, "--show-secret")
            target.send(uri)
            target_sas = target.find(r"SAS code: (\d{6})")
        else:
            env["UNI_PAIR_URI"] = uri
            target = uni("target", env)
            target_sas = target.find(r"SAS (\d{6})")
        source_sas = source.find(r"SAS(?: code:)? (\d{6})")
        if source_sas != target_sas:
            source.send("no")
            target.send("no")
            raise RuntimeError("SAS mismatch")
        source.send("yes" if number != 3 else "y")
        target.send("y" if number == 2 else "yes")
        source.finish("Transfer complete!" if number == 3 else "SUCCESS")
        target.finish("Transfer complete!" if number == 2 else "SUCCESS")
        if number == 2:
            # --show-secret is captured only in this variable, never printed or written to disk.
            payload = next((line.split("custom: ", 1)[1] for line in target.lines if "custom: " in line), None)
            if payload is None:
                raise RuntimeError("CLI missing received identity")
            received = json.loads(payload)
            if received["pubkey"] != pubkey:
                raise RuntimeError("CLI received public key mismatch")
            # Independently derive the public key from the received nsec as well.
            check_env = env.copy()
            check_env["UNI_PAIR_KEY"] = received["nsec"]
            checked = uni("pubkey", check_env)
            if checked.find(r"PUBKEY ([0-9a-f]{64})") != pubkey:
                raise RuntimeError("CLI received secret does not match public key")
            checked.p.wait(timeout=10)
    directions = {1: "Uni source -> Uni target", 2: "Uni source -> Buzz CLI target", 3: "Buzz CLI source -> Uni target"}
    print(f"PASS {label} case {number}: {directions[number]}; SAS and received pubkey match", flush=True)


def main():
    global UNI_BINARY
    metadata = subprocess.run(["cargo", "metadata", "--no-deps", "--format-version", "1"],
                              cwd=ROOT, capture_output=True, text=True, check=True)
    UNI_BINARY = Path(json.loads(metadata.stdout)["target_directory"]) / "debug/examples/pair_interop"
    cargo(ROOT, "build", "--quiet", "-p", "uni-core", "--example", "pair_interop")
    cargo(BUZZ, "build", "--quiet", "--manifest-path", str(BUZZ_CLI_MANIFEST), "--target-dir", str(BUZZ / "target"), "-p", "buzz-pairing-cli")
    cargo(BUZZ, "build", "--quiet", "-p", "buzz-pair-relay")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = os.environ.copy()
    env["BUZZ_PAIR_RELAY_BIND_ADDR"] = f"127.0.0.1:{port}"
    relay = subprocess.Popen(["cargo", "run", "--quiet", "-p", "buzz-pair-relay"], cwd=BUZZ,
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    PROCESSES.append(relay)
    for _ in range(600):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            if relay.poll() is not None:
                raise RuntimeError("local relay exited")
            time.sleep(0.1)
    else:
        raise RuntimeError("local relay unreachable")
    for case in (1, 2, 3):
        run_case(case, f"ws://127.0.0.1:{port}", "local")
    env["UNI_PAIR_KEY"] = secrets.token_hex(32)
    env["UNI_PAIR_RELAY"] = "wss://pairing.buzz.xyz"
    probe = uni("probe", env)
    try:
        probe.find(r"(REACHABLE)", timeout=20)
    except RuntimeError:
        print("SKIP live: wss://pairing.buzz.xyz unavailable (connection/auth/subscription probe)")
        return
    for case in (1, 2, 3):
        run_case(case, env["UNI_PAIR_RELAY"], "live")


if __name__ == "__main__":
    try:
        with tempfile.TemporaryDirectory(prefix="uni-pair-cli-build-") as directory:
            BUZZ_CLI_MANIFEST = prepare_cli_manifest(directory)
            main()
    except Exception as error:
        # Never display exception data from secret-bearing buffers or subprocess arguments.
        print(f"FAIL interop: {str(error) if isinstance(error, RuntimeError) else type(error).__name__}; raw peer output withheld", flush=True)
        raise SystemExit(1)
    finally:
        for process in PROCESSES:
            if process.poll() is None:
                process.terminate()
        for process in PROCESSES:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
