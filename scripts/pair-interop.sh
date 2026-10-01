#!/usr/bin/env bash
# Raw CLI output contains session secrets. The Python harness captures it in memory only.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/pair-interop.py "$@"
