# uni-transcribe

Voice-message transcription for the Uni app: faster-whisper (`small`, CPU int8) on uni-1.

- Install: `uv venv ~/.local/share/uni/transcribe/venv && VIRTUAL_ENV=… uv pip install faster-whisper==1.2.1 coincurve`,
  copy `server.py` next to it, install `uni-transcribe.service` as a user unit.
- Exposed tailnet-only: `sudo tailscale serve --bg --https=8445 http://127.0.0.1:1950`.
- Auth: NIP-98 signed by a pubkey listed in `~/.config/uni/transcribe-allow`. No tokens on devices.
- Off the tailnet a voice message still sends; it just has no transcript.
- Names (T-313): a request is signed for the URL the client reached, and the service accepts each of its names
  (`uni-1` and, after the tailnet rename, `uni`; `UNI_TRANSCRIBE_URLS` overrides). Its check is tested by
  `test_server.py` (run with the service's venv Python).
- Deploy a change: copy `server.py` over `~/.local/share/uni/transcribe/server.py`, then `systemctl --user restart
  uni-transcribe` (a restart: ask first).
