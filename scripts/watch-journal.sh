#!/usr/bin/env bash
# Poll origin/journal and publish when a non-release commit landed since the last build.
set -euo pipefail
export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$HOME/Android/Sdk/platform-tools:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
git fetch --quiet origin journal --tags
LAST_TAG="$(git tag -l 'uni-v[0-9]*' --sort=-v:refname | head -1)"
if [[ -n "$LAST_TAG" ]]; then
  LAST="$(git rev-list -n1 "$LAST_TAG")"
  git merge-base --is-ancestor "$LAST" origin/journal || { echo "Latest release $LAST_TAG is not on journal" >&2; exit 1; }
  CHANGES="$(git log --format='%s' "$LAST..origin/journal" | grep -v '^release: Uni v' || true)"
else CHANGES="initial build"; fi
if [[ -z "$CHANGES" ]]; then
  # No new source. If the latest tag never made it to the live manifest (failed build), retry it.
  [[ -n "$LAST_TAG" ]] || exit 0
  LIVE="$(curl -fsS https://uni-1.taildf9ce2.ts.net:8443/mac/latest.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])' || echo none)"
  [[ "uni-v$LIVE" == "$LAST_TAG" ]] && exit 0
  [[ $(git rev-parse HEAD) == "$LAST" ]] || { echo "Checkout is not at $LAST_TAG; not resuming" >&2; exit 1; }
  echo "$LAST_TAG tagged but live is $LIVE; rebuilding without bump" >&2
  RESUME=1 bash scripts/publish.sh
  exit
fi
# The publisher owns a lock and a clean worktree check. No agents, no silent force pushes.
echo "New journal commits since ${LAST_TAG:-initial}; publishing" >&2
bash scripts/publish.sh
