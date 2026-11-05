#!/usr/bin/env python3
"""uni-route, end to end: the real server, real HTTP, real NIP-98 signatures, its real log. Only `claude` is a stand-in (a third party's model).
Run: uv run --no-project --python 3.13 --with coincurve python services/route/test_server.py. Made-up rooms and words only."""
import base64
import hashlib
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from coincurve import PrivateKey

HERE = Path(__file__).resolve().parent
tmp = Path(tempfile.mkdtemp(prefix="uni-route-test-"))
MARK = "PRIVATE-MARKER-kumquat"
FAKE = tmp / "claude"
FAKE.write_text(f"""#!{sys.executable}
import json, os, sys, time
d = {str(tmp)!r}
open(d + "/argv.json", "w").write(json.dumps(sys.argv[1:]))
open(d + "/envnames.json", "w").write(json.dumps(sorted(os.environ)))
open(d + "/cwd.txt", "w").write(os.getcwd())
if open(d + "/mode").read().strip() == "deadatstart": sys.exit(1)
line = sys.stdin.readline()
open(d + "/prompt.txt", "w").write(line)
mode = open(d + "/mode").read().strip()
def out(o): print(json.dumps(o), flush=True)
if mode == "hang": time.sleep(60)
if mode == "die": sys.exit(1)
out(dict(type="system", subtype="init", tools=["Bash"] if mode == "tools" else [], mcp_servers=[]))
text = {{"garbage": "I would say the kiln", "none": json.dumps(dict(picks=[dict(id="not-a-room", why="x")]))}}.get(mode) or json.dumps(dict(picks=[
    dict(id="not-a-room", why="made up", sure=True),
    dict(id="ch-kiln", why="glaze {MARK} and\\nmany many many many many more words", sure=False),
    dict(id="ch-kiln", why="twice"),
    dict(id="ch-bees", why="honey", sure=True),
    dict(id="ch-north", why="gate"),
    dict(id="ch-table", why="fourth"),
]))
if mode == "error": out(dict(type="result", subtype="error_during_execution", is_error=True, result="{MARK} went wrong"))
else: out(dict(type="result", subtype="success", is_error=False, result=text))
""")
FAKE.chmod(FAKE.stat().st_mode | stat.S_IEXEC)
(tmp / "mode").write_text("ok")

KEY, OTHER = PrivateKey(), PrivateKey()
pub = lambda k: k.public_key.format(compressed=True)[1:].hex()
(tmp / "allow").write_text(f"# the device\n{pub(KEY)}\n")
s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
ORIGIN = "https://door.example.ts.net:8521"
LOG = tmp / "log.jsonl"
(tmp / "runs").mkdir()
env = {**os.environ, "TMPDIR": str(tmp / "runs"), "UNI_ROUTE_PORT": str(PORT), "UNI_ROUTE_URLS": ORIGIN, "UNI_ROUTE_ALLOW": str(tmp / "allow"), "UNI_ROUTE_LOG": str(LOG), "UNI_ROUTE_CLAUDE": str(FAKE),
       "UNI_ROUTE_DEADLINE": "1.5", "SECRET_THING": "must-not-reach-the-model", "HOME": str(tmp)}
out = open(tmp / "server.out", "w")
server = subprocess.Popen([sys.executable, "-I", str(HERE / "server.py")], env=env, stdout=out, stderr=subprocess.STDOUT)

ROOMS = [{"id": "ch-kiln", "name": "Kiln Studio", "about": "Firing days"}, {"id": "ch-bees", "name": "Bee Garden", "about": "Hives"}, {"id": "ch-north", "name": "North Field", "about": ""}, {"id": "ch-table", "name": "Long Table", "about": "Suppers"}]
passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


def sign(path, body, key=KEY, url=None, method="POST", created=None, payload=None, kind=27235, bad_id=False):
    tags = [["u", url or ORIGIN + path], ["method", method], ["nonce", os.urandom(8).hex()], ["payload", payload or hashlib.sha256(body).hexdigest()]]
    created = created or int(time.time())
    pk = pub(key)
    eid = hashlib.sha256(json.dumps([0, pk, created, kind, tags, ""], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    sig = key.sign_schnorr(bytes.fromhex(eid)).hex()
    ev = {"id": ("0" * 64 if bad_id else eid), "pubkey": pk, "created_at": created, "kind": kind, "tags": tags, "content": "", "sig": sig}
    return "Nostr " + base64.b64encode(json.dumps(ev).encode()).decode()


def post(path, obj, auth="sign", **kw):
    body = json.dumps(obj).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=body, method="POST", headers={"Content-Type": "application/json"})
    if auth == "sign":
        auth = sign(path, body, **kw)
    if auth:
        req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def wait_warm():
    # the stand-in reads stdin straight away, so `warm` is alive; wait for the door to have one
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/route/v1/health", timeout=2) as r:
                if json.loads(r.read()).get("warm"):
                    return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


def mode(m):
    (tmp / "mode").write_text(m)


try:
    check("starts and warms a process", wait_warm())
    SUG, OUT = "/route/v1/suggest", "/route/v1/outcome"
    ask = {"text": f"The glaze {MARK} crawled again", "rooms": ROOMS}

    # auth: every way in is refused before the model is touched
    (tmp / "prompt.txt").unlink(missing_ok=True)
    body = json.dumps(ask).encode()
    check("no signature", post(SUG, ask, auth=None)[0] == 401)
    check("a key not on the list", post(SUG, ask, key=OTHER)[0] == 401)
    check("another door's url", post(SUG, ask, url="https://other.example.ts.net:8521" + SUG)[0] == 401)
    check("another path's signature", post(SUG, ask, url=ORIGIN + OUT)[0] == 401)
    check("a signature for other words", post(SUG, ask, payload=hashlib.sha256(b"other").hexdigest())[0] == 401)
    check("too old", post(SUG, ask, created=int(time.time()) - 600)[0] == 401)
    check("wrong kind", post(SUG, ask, kind=1)[0] == 401)
    check("a forged id", post(SUG, ask, bad_id=True)[0] == 401)
    check("wrong method in the tag", post(SUG, ask, method="GET")[0] == 401)
    check("the model was never asked", not (tmp / "prompt.txt").exists())
    once = sign(SUG, body)
    st1 = post(SUG, ask, auth=once)
    check("a good signature works", st1[0] == 200, st1)
    check("the same signature twice", post(SUG, ask, auth=once)[0] == 401)

    # the answer is kept to what the app may show
    picks = st1[1].get("picks", [])
    check("known rooms, each once, at most three", [p["id"] for p in picks] == ["ch-kiln", "ch-bees", "ch-north"], picks)
    check("only the first can be sure (it wasn't)", [p["sure"] for p in picks] == [False, False, False], picks)
    check("a reason is a few words, one line", len(picks[0]["why"].split()) <= 6 and len(picks[0]["why"]) <= 48 and "\n" not in picks[0]["why"], picks[0])
    check("a suggestion id", len(st1[1]["id"]) == 32)
    prompt = json.loads((tmp / "prompt.txt").read_text())["message"]["content"]
    check("the prompt has the words and the one-liners, marked as data", MARK in prompt and "Firing days" in prompt and "<message>" in prompt)

    # locked down: checked on what the process really got
    argv = json.loads((tmp / "argv.json").read_text())
    joined = " ".join(argv)
    check("no tools", argv[argv.index("--tools") + 1] == "")
    names0 = json.loads((tmp / "envnames.json").read_text())
    for k in ("DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"):
        check(f"env {k}", k in names0)
    for flag in ("--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"):
        check(f"flag {flag}", flag in argv)
    check("Haiku 5.5", argv[argv.index("--model") + 1] == "claude-haiku-5-5")
    check("the words aren't on the command line", MARK not in joined)
    names = json.loads((tmp / "envnames.json").read_text())
    check("the server's other env doesn't reach the model", "SECRET_THING" not in names and "UNI_ROUTE_ALLOW" not in names, names)

    # a run leaves nothing behind
    cwd = (tmp / "cwd.txt").read_text()
    for _ in range(40):
        if not Path(cwd).exists():
            break
        time.sleep(0.05)
    check("its directory is gone", not Path(cwd).exists(), cwd)

    # the next process really waits: it is still there a moment after the last was used
    time.sleep(1.0)
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/route/v1/health", timeout=2) as r:
        check("a process is waiting after a request", json.loads(r.read()).get("warm") is True)

    # bad answers are errors, and name nothing
    wait_warm()
    for m, code in (("garbage", 502), ("none", 502), ("tools", 502), ("error", 502), ("hang", 504), ("die", 502)):
        mode(m)
        # a process already waiting was started in the old mode: the stand-in reads its mode only after the words arrive, so this applies
        started = time.time()
        st, ans = post(SUG, ask)
        check(f"{m} answers {code}", st == code, (st, ans))
        check(f"{m} says nothing of the words", MARK not in json.dumps(ans), ans)
        if m == "hang":
            check("a hung run is cut off at the deadline", time.time() - started < 3, time.time() - started)
    mode("ok")
    wait_warm()

    # a model process that dies at start leaves nothing behind (auth lapsed, a bad upgrade): one directory at a time, however long it goes on
    mode("deadatstart")
    time.sleep(0.2)
    for _ in range(6):
        post(SUG, ask)
    time.sleep(0.5)
    runs = list((tmp / "runs").glob("uni-route-*"))
    check("dead processes don't pile up directories", len(runs) <= 2, [p.name for p in runs])
    mode("ok")
    # the next ask starts a process that doesn't die, and the door is whole again
    st, _ans = post(SUG, ask)
    check("the door recovers once the model does", st == 200, (st, _ans))
    wait_warm()

    # a bad header is an answer, not a traceback
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{SUG}", data=b"{}", method="POST", headers={"Authorization": "Nostr x"})
    req.add_header("Content-Type", "application/json")
    try:
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as e:
        check("an unreadable signature is refused", e.code == 401)
    with socket.create_connection(("127.0.0.1", PORT), timeout=5) as c:
        c.sendall(b"POST /route/v1/suggest HTTP/1.0\r\nContent-Length: nonsense\r\n\r\n")
        check("a nonsense length is refused", b" 413 " in c.recv(200))

    # input is bounded
    check("no rooms", post(SUG, {"text": "hello there", "rooms": []})[0] == 400)
    check("a room id that isn't one", post(SUG, {"text": "hello there", "rooms": [{"id": "a b", "name": "x"}]})[0] == 400)
    check("too long", post(SUG, {"text": "x" * 5000, "rooms": ROOMS})[0] == 413)

    # the outcome: room ids against what was sent, and nothing else can reach the log
    sid = post(SUG, ask)[1]["id"]
    good = {"suggestion": sid, "model": ["ch-kiln", "ch-bees"], "modelState": "in-time", "words": ["ch-north"], "sent": ["ch-kiln"], "edited": True}
    check("an outcome is taken", post(OUT, good)[0] == 200)
    check("an extra field is dropped", post(OUT, {**good, "text": MARK})[0] == 200)
    check("text as a room id is refused", post(OUT, {**good, "sent": [MARK + " hello there"]})[0] == 400)
    check("text as a state is refused", post(OUT, {**good, "modelState": MARK})[0] == 400)
    check("text as a suggestion id is refused", post(OUT, {**good, "suggestion": MARK})[0] == 400)
    check("an outcome without a signature", post(OUT, good, auth=None)[0] == 401)

    logged = LOG.read_text()
    rows = [json.loads(x) for x in logged.splitlines()]
    check("the log has the suggestions and the outcomes", {r["kind"] for r in rows} == {"suggest", "outcome"} and sum(r["kind"] == "outcome" for r in rows) == 2)
    check("the log never holds the words or a reason", MARK not in logged and "glaze" not in logged and "crawled" not in logged, logged[:300])
    check("the log is private", stat.S_IMODE(LOG.stat().st_mode) == 0o600)
    out.flush()
    said = (tmp / "server.out").read_text()
    check("the server's own output never holds the words", MARK not in said)
    check("no traceback in its output", "Traceback" not in said, said[-400:])
    last = [r for r in rows if r["kind"] == "outcome"][-1]
    check("an outcome's row is only its fields", set(last) == {"at", "kind", "sid", "state", "model", "words", "sent", "edited"}, last)

    # the report says whether the model helps
    rep = subprocess.run([sys.executable, "-I", str(HERE / "server.py"), "--report"], env=env, capture_output=True, text=True).stdout
    check("the report counts first picks", "model's first pick was sent to: 2 of 2" in rep and "word match's first pick was sent to: 0 of 2" in rep, rep)
finally:
    server.terminate()
    try:
        server.wait(5)
    except subprocess.TimeoutExpired:
        server.kill()
    out.close()
    time.sleep(0.2)
    check("a stopped door leaves no run directory", not list((tmp / "runs").glob("uni-route-*")), [p.name for p in (tmp / "runs").glob("*")])
    shutil.rmtree(tmp, ignore_errors=True)
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
