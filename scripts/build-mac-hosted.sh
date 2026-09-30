#!/usr/bin/env bash
# Dispatch a signed macOS build and verify its release assets before publishing.
set -euo pipefail
SHA="${1:?40-character release commit required}"
VERSION="${2:?release version required}"
OUT="${3:?output directory required}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
REPO=unforcedagi/uni-app
ENVIRONMENT=uni-mac-signing
KEY_DIR="$HOME/.config/uni/updater"
for file in macsign.p12 macsign.pass uni.key; do test -s "$KEY_DIR/$file"; done
policies="$(gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name')"
[[ "$policies" == main ]] || { echo "Signing environment must allow main only; found: $policies" >&2; exit 1; }
secret_names=(MACSIGN_P12_BASE64 MACSIGN_P12_PASSWORD TAURI_SIGNING_PRIVATE_KEY)
list_secrets() {
  timeout 20s gh secret list -R "$REPO" -e "$ENVIRONMENT" --json name --jq '.[].name'
}
existing="$(list_secrets)" # An API failure is fatal; never assume the environment is empty.
for name in "${secret_names[@]}"; do
  if grep -Fxq "$name" <<< "$existing"; then
    echo "Signing secret $name already exists: refusing to overwrite or delete it" >&2
    exit 1
  fi
done
# Only delete names this invocation attempted to create; never touch pre-existing secrets.
created=()
cleanup() {
  local code=$? name attempt listed clean deleted
  trap - EXIT
  for name in "${created[@]}"; do
    clean=0
    for attempt in 1 2 3; do
      # Require both successful deletion and an exact-name absence read-back.
      deleted=0
      if timeout 20s gh secret delete "$name" -R "$REPO" -e "$ENVIRONMENT" >/dev/null 2>&1; then deleted=1; fi
      if listed="$(list_secrets)"; then
        if (( deleted )) && ! grep -Fxq "$name" <<< "$listed"; then clean=1; break; fi
      fi
      sleep 2
    done
    if (( ! clean )); then
      echo "Signing secret cleanup unverified: $name (delete manually)" >&2
      code=1
    fi
  done
  exit "$code"
}
trap cleanup EXIT
created+=(MACSIGN_P12_BASE64)
base64 -w0 "$KEY_DIR/macsign.p12" | gh secret set MACSIGN_P12_BASE64 -R "$REPO" -e "$ENVIRONMENT"
created+=(MACSIGN_P12_PASSWORD)
tr -d '\r\n' < "$KEY_DIR/macsign.pass" | gh secret set MACSIGN_P12_PASSWORD -R "$REPO" -e "$ENVIRONMENT"
created+=(TAURI_SIGNING_PRIVATE_KEY)
gh secret set TAURI_SIGNING_PRIVATE_KEY -R "$REPO" -e "$ENVIRONMENT" < "$KEY_DIR/uni.key"
nonce="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run mac-build.yml -R "$REPO" --ref main -f source_sha="$SHA" -f version="$VERSION" -f release_nonce="$nonce"
run=''
for attempt in {1..24}; do
  runs="$(gh run list -R "$REPO" --workflow mac-build.yml --branch main --event workflow_dispatch --limit 100 \
    --json databaseId,headSha,displayTitle)"
  run="$(printf '%s' "$runs" | python3 scripts/select-mac-run.py "$SHA" "$VERSION" "$nonce")"
  [[ -n "$run" ]] && break
  sleep 5
done
[[ -n "$run" ]] || { echo 'Dispatched workflow, but could not identify nonce-matched run' >&2; exit 1; }
echo "Mac build run: $run" >&2
timeout 150m gh run watch "$run" -R "$REPO" --exit-status
mkdir -p "$OUT"
gh run download "$run" -R "$REPO" -n uni-mac-arm64 -D "$OUT"
for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do test -s "$OUT/$f"; done
python3 scripts/verify-mac-assets.py "$OUT" "$VERSION" src-tauri/tauri.conf.json
printf 'Verified Mac build assets downloaded to %s\n' "$OUT" >&2
