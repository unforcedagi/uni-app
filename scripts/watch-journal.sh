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
[[ -n "$CHANGES" ]] || exit 0
# The publisher owns a lock and a clean worktree check. No agents, no silent force pushes.
echo "New journal commits since ${LAST_TAG:-initial}; publishing" >&2
bash scripts/publish.sh
