# uni-route

A small model's suggestion for where an unaddressed message goes, for the Uni app's All composer. The word match on the device is the instant first
guess and the fallback; this only improves it. Nothing sends without the person's tap.

- Runs Claude Code headless (`claude -p --model claude-haiku-5-5`) on the subscription the rest of Uni uses. No API key. Never a third-party classifier.
- One process waits, started ahead of time, and is used once: a cold start takes longer than the app waits (1.5 s).
- Message text is never logged or kept. `~/.local/state/uni-route/log.jsonl` holds room ids and timings; `server.py --report` says whether the model helps.
- Auth: NIP-98 signed by a pubkey in `~/.config/uni/route-allow`. No tokens on devices.

Install:

```sh
uv venv --python 3.13 ~/.local/share/uni/route/venv && VIRTUAL_ENV=~/.local/share/uni/route/venv uv pip install coincurve
cp server.py ~/.local/share/uni/route/ && cp uni-route.service ~/.config/systemd/user/
cp ~/.config/uni/transcribe-allow ~/.config/uni/route-allow
echo 'UNI_ROUTE_URLS=https://<the hub host>:8521' > ~/.config/uni/route.env
systemctl --user daemon-reload && systemctl --user enable --now uni-route
sudo tailscale serve --bg --https=8521 http://127.0.0.1:18521
```

Tests: `python3 -I services/route/test_server.py`, with a stand-in for `claude` (the door, its auth and its log are real).
