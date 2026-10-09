#!/usr/bin/env bash
# T-77b P3-3: build the frontend clean, with the T-76 harness mock off, and prove no harness code is in dist/.
# Wired in as tauri `beforeBuildCommand`, so every release build (Linux, Mac, Android) goes through it.
set -euo pipefail
cd "$(dirname "$0")/.."
unset UNI_T76
rm -rf dist
npm run build:vite
if grep -rlE '__T76_MOCK' dist/assets; then
  echo 'check-release-dist: __T76_MOCK found in dist/assets (harness build leaked into a release)' >&2
  exit 1
fi
echo 'check-release-dist: dist/ is clean'
