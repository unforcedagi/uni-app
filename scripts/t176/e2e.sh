#!/usr/bin/env bash
# T-176 end-to-end: build the app-side driver, then run the throwaway relay + plugin + app with Hermes' venv python:
# e2e.py (the plugin's Runtime driven directly) and gateway_boundary.py (the plugin loaded by Hermes' own loader,
# through the real Buzz adapter filter, pre_gateway_dispatch dispatch and inject_message path).
set -euo pipefail
cd "$(dirname "$0")/../.."
# The uni-secrets plugin is private and not in this repo: stage it in the git-ignored hermes-plugin/uni-secrets,
# or name its folder in UNI_SECRETS_PLUGIN.
PLUGIN="${UNI_SECRETS_PLUGIN:-$PWD/hermes-plugin/uni-secrets}"
[[ -f "$PLUGIN/desk.py" ]] || { echo "e2e: no uni-secrets plugin at $PLUGIN (set UNI_SECRETS_PLUGIN)" >&2; exit 2; }
export UNI_SECRETS_PLUGIN="$PLUGIN"
cargo build -q -p uni-core --example secret_send
PY="${HERMES_PY:-$HOME/REPOS/hermes-agent/.venv/bin/python}"
"$PY" -B -I scripts/t176/e2e.py "$@"
exec "$PY" -B -I scripts/t176/gateway_boundary.py "$@"
