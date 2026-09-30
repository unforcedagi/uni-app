"""Select only the run dispatched with our unique nonce and exact commit."""
import json
import sys

sha, version, nonce = sys.argv[1:]
title = f"Uni {version} ({nonce})"
runs = json.load(sys.stdin)
matches = [r["databaseId"] for r in runs if r.get("headSha") == sha and r.get("displayTitle") == title]
if len(matches) > 1:
    raise SystemExit("Duplicate hosted Mac build nonce: refusing ambiguous run")
if matches:
    print(matches[0])
