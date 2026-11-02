#!/usr/bin/env python3
"""T-335 live proof, step 1: park a send with files on a real mail bridge, as Uni's key would.

  mail-live-park.py --bridge URL --key HEXFILE --to ADDRESS --subject TEXT FILE [FILE ...]

Signs NIP-98 requests with the 64-hex secret key in HEXFILE (a throwaway key mapped to a test "uni" account on a
scratch bridge; never Uni's real key), finds that key's own account, saves a draft with the files (draft.save
attachments), reviews it, and sends it under a fresh test opId. The scratch bridge's outbound rules hold mail to
ADDRESS for the owner, so the answer must be awaiting-approval: nothing goes out until the owner approves it in the app
(mail-live.spec.ts). Prints one JSON line: opId, draftId, fingerprint, and each file's name, size and SHA-256.
Never prints a key. Needs coincurve: run with the mail bridge's venv python and -I.
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

from coincurve import PrivateKey


def nip98(key, url, body):
    pub = key.public_key_xonly.format().hex()
    tags = [["u", url], ["method", "POST"], ["payload", hashlib.sha256(body).hexdigest()]]
    created = int(time.time())
    ser = json.dumps([0, pub, created, 27235, tags, ""], separators=(",", ":"), ensure_ascii=False).encode()
    eid = hashlib.sha256(ser).hexdigest()
    ev = {"id": eid, "pubkey": pub, "created_at": created, "kind": 27235, "tags": tags, "content": "",
          "sig": key.sign_schnorr(bytes.fromhex(eid)).hex()}
    return "Nostr " + base64.b64encode(json.dumps(ev).encode()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--text", default="Hello,\n\nAttached are the volunteer rota and the notes, as promised.\n\nUni\n")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    key = PrivateKey(bytes.fromhex(open(a.key).read().strip()))

    def call(path, payload):
        body = json.dumps(payload).encode()
        req = urllib.request.Request(a.bridge + path, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": nip98(key, a.bridge + path, body)})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{path} {payload.get('op', '')}: {e.code} {e.read()[:300]!r}")
        time.sleep(1)  # the bridge refuses two identical signatures in one second as a replay
        return out

    s = call("/mail/session", {})
    me = [i for i, r in s.get("roles", {}).items() if r == "uni"]
    if len(me) != 1:
        raise SystemExit(f"expected one uni account in this key's session, got {me}")
    acct = me[0]
    files = []
    for p in a.files:
        data = open(p, "rb").read()
        files.append({"name": os.path.basename(p), "type": mimetypes.guess_type(p)[0] or "application/octet-stream",
                      "base64": base64.b64encode(data).decode(), "_sha256": hashlib.sha256(data).hexdigest(), "_size": len(data)})
    d = call("/mail/op", {"op": "draft.save", "accountId": acct,
                          "fields": {"to": [{"email": a.to}], "subject": a.subject, "text": a.text},
                          "attachments": [{k: v for k, v in f.items() if not k.startswith("_")} for f in files]})
    r = call("/mail/op", {"op": "draft.review", "accountId": acct, "draftId": d["draftId"]})
    listed = r.get("fields", {}).get("attachments")
    want = [{"name": f["name"], "type": f["type"], "size": f["_size"], "sha256": f["_sha256"]} for f in files]
    if listed != want or r.get("plain") is not False or r["fingerprint"] != d["fingerprint"]:
        raise SystemExit(f"review doesn't list the files as sent: {listed} plain={r.get('plain')}")
    op_id = "test-t335-app-" + secrets.token_hex(8)
    out = call("/mail/op", {"op": "send", "accountId": acct, "opId": op_id, "draftId": d["draftId"], "fingerprint": d["fingerprint"]})
    if out.get("state") != "awaiting-approval":
        raise SystemExit(f"expected the send to be held, got {out.get('state')}: {out.get('reason')}")
    print(json.dumps({"opId": op_id, "draftId": d["draftId"], "account": acct, "fingerprint": d["fingerprint"], "reason": out.get("reason"),
                      "files": [{"name": f["name"], "size": f["_size"], "sha256": f["_sha256"]} for f in files]}))


if __name__ == "__main__":
    sys.exit(main())
