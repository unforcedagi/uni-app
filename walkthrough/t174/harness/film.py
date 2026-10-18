#!/usr/bin/env python3
"""T-174 walkthrough film: scenes cut from the real recordings (Linux: the cage frame grabs; Android: screenrecord),
one Kokoro line each (am_michael), the picture held on its last frame while a line runs long; relay-safe MP4.
usage: ~/studio/.venv/bin/python film.py <linux run dir> <android run dir> <work dir> <out.mp4>"""
import glob, json, os, subprocess, sys
LIN, AND, WORK, OUT = sys.argv[1:5]
os.makedirs(WORK, exist_ok=True)
run = lambda *a: subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *a], check=True)
dur = lambda p: float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]))

# Linux: the frame grabs (one every ~0.15 s, named by ms) → a video on the same clock.
frames = sorted(glob.glob(f'{LIN}/frames/*.jpg'))
t0 = int(os.path.basename(frames[0]).split('.')[0])
desk = f'{WORK}/desktop.mp4'
if not os.path.exists(desk):
    with open(f'{WORK}/frames.txt', 'w') as f:
        for a, b in zip(frames, frames[1:] + frames[-1:]):
            d = max(0.04, (int(os.path.basename(b).split('.')[0]) - int(os.path.basename(a).split('.')[0])) / 1000) if a != b else 0.5
            f.write(f"file '{a}'\nduration {d:.3f}\n")
    run('-f', 'concat', '-safe', '0', '-i', f'{WORK}/frames.txt', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', desk)
L = {os.path.basename(m)[5:]: (int(open(m).read()) - t0) / 1000 for m in glob.glob(f'{LIN}/mark-*')}
# Android: screenrecord started at rec-start (plus ~0.7 s for it to begin).
r0 = int(open(f'{AND}/rec-start').read()) + 700
A = {k: (v - r0) / 1000 for k, v in json.load(open(f'{AND}/android-marks.json')).items()}
ANDR = f'{AND}/android-run.mp4'

before = f'{WORK}/before.png'
subprocess.run(['magick', '-size', '1280x720', 'xc:#1c1f1d', '-fill', '#e8efe9', '-font', 'Liberation-Sans', '-pointsize', '44', '-annotate', '+80+170', 'Before (Android 13, previous build)',
                '-pointsize', '30', '-fill', '#c9d3cc', '-annotate', '+80+260', 'Save:  "Cached"  (the file stayed in the app\'s private cache)',
                '-annotate', '+80+320', 'Open:  "Cannot construct instance of app.tauri.opener.OpenArgs…"',
                '-annotate', '+80+420', 'Nothing landed anywhere you could find it.', before], check=True)
SCENES = [
    (before, 0, 6, "Before this fix, Save only copied a file into the app's private cache and said: cached. On Android, Open failed inside the app. So, from where you sat, nothing happened."),
    (desk, L['01-cards'] - 2.5, L['01-cards'], "This is the real Linux build, with three attachments in a room: a PDF, a 35 megabyte class video, and a photo."),
    (desk, L['01-cards'], L['02-pdf-saved'], "Tap Save. The file downloads with your key, its fingerprint is checked, and it goes into your Downloads folder. The card says exactly where."),
    (desk, L['02-pdf-saved'], L['03-pdf-opened'] + 1.5, "Open hands it to the PDF viewer."),
    (desk, L['05-video-saved'] - 4.0, L['05-video-saved'], "Videos have a Save button now too. Here, the 35 megabyte class."),
    (desk, L['07-lightbox'] - 1.5, L['08-image-saved'] + 0.5, "Photos save from the full-screen view."),
    (desk, L['09-error'] - 3.5, L['09-error'], "And when it can't, here a file that's gone from the relay, the card says why, instead of nothing happening."),
    (ANDR, A['01-cards'] - 1.0, A['02-pdf-saved'] + 0.5, "Now Android 13 on the emulator, the Daylight's version. Save puts the PDF in the phone's Downloads."),
    (ANDR, A['02-pdf-saved'] + 0.5, A['03-pdf-opened'] + 1.0, "Open shows it in the phone's PDF viewer. This is the step that used to fail."),
    (ANDR, A['04-video-saving'] - 1.0, A['05-video-saved'] + 0.5, "The class video saves the same way."),
    (ANDR, A['07-lightbox'] - 1.0, A['08-image-saved'] + 0.8, "And the photo, from the full-screen view."),
    # screenrecord only writes frames on change and stops before this mark: the Files app from its screen grab.
    (f'{AND}/android-09-downloads.png', 0, 3, "All three are in Downloads, where the Files app shows them. Not tested yet: your Daylight itself, which wasn't connected, and the Mac, which I checked only by reading the code."),
]
from kokoro_onnx import Kokoro
import soundfile as sf
K = os.path.expanduser('~/.local/share/kokoro')
k = Kokoro(f'{K}/kokoro.onnx', f'{K}/voices.bin')
parts = []
for i, (src, a, b, line) in enumerate(SCENES):
    wav = f'{WORK}/n{i}.wav'
    if not os.path.exists(wav) or open(f'{wav}.txt').read() != line if os.path.exists(f'{wav}.txt') else True:
        audio, sr = k.create(line, voice='am_michael', speed=1.0, lang='en-us')
        sf.write(wav, audio, sr); open(f'{wav}.txt', 'w').write(line)
    length = max(b - a, dur(wav) + 0.9)
    part = f'{WORK}/part{i}.mp4'
    vf = ('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,'
          f'tpad=stop_mode=clone:stop_duration={length:.2f},format=yuv420p')
    src_args = ['-loop', '1', '-t', f'{length:.2f}', '-i', src] if src.endswith('.png') else ['-ss', f'{max(0, a):.2f}', '-t', f'{b - a:.2f}', '-i', src]
    run(*src_args, '-i', wav, '-filter_complex', f'[0:v]{vf}[v];[1:a]aresample=48000,adelay=300|300,apad[a]',
        '-map', '[v]', '-map', '[a]', '-t', f'{length:.2f}', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-ac', '1', part)
    parts.append(part)
    print(i, round(a, 2), round(length, 2), round(dur(wav), 2))
with open(f'{WORK}/parts.txt', 'w') as f:
    f.writelines(f"file '{p}'\n" for p in parts)
run('-f', 'concat', '-safe', '0', '-i', f'{WORK}/parts.txt',
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    '-metadata:s:v', 'handler_name=', '-metadata:s:a', 'handler_name=', '-c:v', 'libx264', '-x264-params', 'no-info=1',
    '-pix_fmt', 'yuv420p', '-crf', '24', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', OUT)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type:format=duration,size', '-of', 'compact', OUT]).decode())
