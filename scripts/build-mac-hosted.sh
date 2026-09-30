#!/usr/bin/env bash
# Dispatch a signed macOS build and download its three release assets.
# Secrets live only in the main-restricted environment for the duration of this command.
set -euo pipefail
SHA="${1:?40-character release commit required}"
VERSION="${2:?release version required}"
OUT="${3:?output directory required}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
REPO=unforcedagi/uni-app
ENVIRONMENT=uni-mac-signing
KEY_DIR="$HOME/.config/uni/updater"
for file in macsign.p12 macsign.pass uni.key; do test -s "$KEY_DIR/$file"; done
# Fail closed if this environment has been widened to another branch.
policies="$(gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name')"
[[ "$policies" == main ]] || { echo "Signing environment must allow main only; found: $policies" >&2; exit 1; }
[[ -z $(gh secret list -R "$REPO" -e "$ENVIRONMENT" --json name --jq '.[].name' | grep -E '^(MACSIGN_P12_BASE64|MACSIGN_P12_PASSWORD|TAURI_SIGNING_PRIVATE_KEY)$' || true) ]] || {
  echo 'Signing secrets already exist: refusing to overwrite or delete them' >&2; exit 1;
}
cleanup() {
  local code=$?
  trap - EXIT
  for name in MACSIGN_P12_BASE64 MACSIGN_P12_PASSWORD TAURI_SIGNING_PRIVATE_KEY; do
    gh secret delete "$name" -R "$REPO" -e "$ENVIRONMENT" >/dev/null 2>&1 || true
  done
  exit "$code"
}
trap cleanup EXIT
base64 -w0 "$KEY_DIR/macsign.p12" | gh secret set MACSIGN_P12_BASE64 -R "$REPO" -e "$ENVIRONMENT"
tr -d '\r\n' < "$KEY_DIR/macsign.pass" | gh secret set MACSIGN_P12_PASSWORD -R "$REPO" -e "$ENVIRONMENT"
gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" -e "$ENVIRONMENT" < "$KEY_DIR/uni.key"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run mac-build.yml -R "$REPO" --ref main -f source_sha="$SHA" -f version="$VERSION"
run=''
for attempt in {1..24}; do
  run="$(gh run list -R "$REPO" --workflow mac-build.yml --branch main --event workflow_dispatch --limit 20 \
    --json databaseId,headSha,createdAt --jq ".[] | select(.headSha == \"$SHA\" and .createdAt >= \"$started\") | .databaseId" | head -1)"
  [[ -n "$run" ]] && break
  sleep 5
done
[[ -n "$run" ]] || { echo 'Dispatched workflow, but could not identify run' >&2; exit 1; }
echo "Mac build run: $run" >&2
gh run watch "$run" -R "$REPO" --exit-status
mkdir -p "$OUT"
gh run download "$run" -R "$REPO" -n uni-mac-arm64 -D "$OUT"
for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do test -s "$OUT/$f"; done
printf 'Mac build assets downloaded to %s\n' "$OUT" >&2
