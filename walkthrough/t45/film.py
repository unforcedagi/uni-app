#!/usr/bin/env python3
"""T-45 walkthrough film: real-app stills + Kokoro narration -> WALKTHROUGH-T45.mp4 (relay-safe encode).
Run with a Python that has kokoro_onnx + soundfile (on uni: ~/studio/.venv/bin/python)."""
import os, subprocess, sys
W = os.path.dirname(os.path.abspath(__file__))
R = os.environ.get('RUNS', f'{W}/runs')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(W), 'WALKTHROUGH-T45.mp4')
D = os.environ.get('FILM_DIR', f'{W}/film'); os.makedirs(D, exist_ok=True)
SCENES = [
    (f'{R}/main/01-inbox.png', "This is Mail in the Uni app, a real Linux build, reading made-up test mail. The Inbox is newest first. Unread mail is bold, and the header says read-only."),
    (f'{R}/main/02-plain.png', "A plain message reads as text. Opening it doesn't mark it read. The app never changes anything on the mail server."),
    (f'{R}/main/03-html.png', "This newsletter is HTML only. The app cleans it, runs no scripts, and skips its remote images, so no tracking pixel fires."),
    (f'{R}/main/04-attachment.png', "With both versions, plain text comes first. The PDF opens through the app, which fetches it from the bridge. The page never holds a mail password."),
    (f'{R}/main/05-formatted.png', "Show formatted switches to the HTML version."),
    (f'{R}/main/06-disguised.png', "invoice dot P N G is really an SVG, which can run script. Its name, its declared type and its bytes don't agree, so the app refuses it."),
    (f'{R}/main/07-office.png', "budget dot docx hides an embedded object. The app reads the file's parts and refuses it. Word and R T F files with fields are refused too: the strict rule for version one."),
    (f'{R}/main/08-empty.png', "An empty mailbox says so."),
    (f'{R}/not-allowed/09-not-allowed.png', "And if the bridge doesn't know this device's key, Mail says so, and shows the key to hand over."),
]
from kokoro_onnx import Kokoro
import soundfile as sf
K = os.path.expanduser('~/.local/share/kokoro')
k = Kokoro(f'{K}/kokoro.onnx', f'{K}/voices.bin')
def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]))
parts = []
for i, (img, line) in enumerate(SCENES):
    wav = f'{D}/n{i}.wav'
    a, sr = k.create(line, voice='am_michael', speed=1.0, lang='en-us'); sf.write(wav, a, sr)
    t = dur(wav) + 0.9
    out = f'{D}/s{i}.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', img, '-i', wav, '-filter_complex',
        '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=10,format=yuv420p[v];[1:a]aresample=48000,apad[a]',
        '-map', '[v]', '-map', '[a]', '-t', f'{t:.2f}', '-c:v', 'libx264', '-crf', '24', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', out], check=True)
    parts.append(out)
with open(f'{D}/list.txt', 'w') as f:
    f.write(''.join(f"file '{p}'\n" for p in parts))
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{D}/list.txt', '-c:v', 'libx264', '-x264-params', 'no-info=1', '-crf', '24',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-metadata:s:v', 'handler_name=', '-metadata:s:a', 'handler_name=', '-movflags', '+faststart', OUT], check=True)
print(OUT, os.path.getsize(OUT), dur(OUT))
