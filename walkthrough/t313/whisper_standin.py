#!/usr/bin/env python3
"""T-313 walkthrough: a transcriber on this machine for the dev bridge's --transcribe-url, running what uni-transcribe runs
(faster-whisper `small`, beam 1, VAD) without its NIP-98 sign-in, which needs an allowlisted device key this machine
doesn't hold. POST /transcribe with the audio, answers {"text", "language", "duration"}. 127.0.0.1 only.

  whisper_standin.py PORT     (run with ~/.local/share/uni/transcribe-gpu/venv/bin/python, HF_HUB_OFFLINE=1)
"""
import json, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=4)
lock = threading.Lock()


class H(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {'ok': True})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not 0 < n <= 25 * 1024 * 1024:
            return self.reply(413, {'error': 'empty or too large'})
        body = self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix='.audio') as f:
            f.write(body)
            f.flush()
            with lock:
                segments, info = model.transcribe(f.name, beam_size=1, vad_filter=True)
                text = ' '.join(s.text.strip() for s in segments).strip()
        print(f'{len(body)}B {info.duration:.1f}s -> {len(text)} chars', flush=True)
        self.reply(200, {'text': text, 'language': info.language, 'duration': round(info.duration, 2)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
