#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.config/systemd/user"
install -m 644 scripts/systemd/uni-updater.service "$HOME/.config/systemd/user/uni-updater.service"
install -m 644 scripts/systemd/uni-updater.timer "$HOME/.config/systemd/user/uni-updater.timer"
systemctl --user daemon-reload
systemctl --user enable --now uni-updater.timer
systemctl --user list-timers --all uni-updater.timer --no-pager
