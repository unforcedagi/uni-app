#!/usr/bin/env python3
"""T-204 walkthrough film: scenes cut from the real runs (Linux: cage frame grabs from run-desktop.sh; Android:
screenrecord from android-run.sh), one Kokoro line each (am_michael), the picture held while a line runs long.
usage: ~/studio/.venv/bin/python film.py <desktop run dir> <android run dir> <work dir> <out.mp4>"""
import glob, json, os, subprocess, sys
LIN, AND, WORK, OUT = sys.argv[1:5]
os.makedirs(WORK, exist_ok=True)
run = lambda *a: subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *a], check=True)
dur = lambda p: float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]))

frames = sorted(glob.glob(f'{LIN}/frames/*.jpg'))
t0 = int(os.path.basename(frames[0]).split('.')[0])
desk = f'{WORK}/desktop.mp4'
with open(f'{WORK}/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + frames[-1:]):
        d = max(0.04, (int(os.path.basename(b).split('.')[0]) - int(os.path.basename(a).split('.')[0])) / 1000) if a != b else 0.5
        f.write(f"file '{a}'\nduration {d:.3f}\n")
run('-f', 'concat', '-safe', '0', '-i', f'{WORK}/frames.txt', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', desk)
L = {os.path.basename(m)[5:]: (int(open(m).read()) - t0) / 1000 for m in glob.glob(f'{LIN}/mark-*')}
r0 = int(open(f'{AND}/rec-start').read()) + 700
A = {k: (v - r0) / 1000 for k, v in json.load(open(f'{AND}/android-marks.json')).items()}
ANDR = f'{AND}/android-run.mp4'

def card(path, title, lines):
    args = ['magick', '-size', '1280x720', 'xc:#1c1f1d', '-fill', '#e8efe9', '-font', 'Liberation-Sans', '-pointsize', '42', '-annotate', '+80+160', title, '-pointsize', '28', '-fill', '#c9d3cc']
    for i, line in enumerate(lines):
        args += ['-annotate', f'+80+{250 + i * 56}', line]
    subprocess.run(args + [path], check=True)

check_d = open(f'{LIN}/check.txt').read().strip().splitlines()[-1]
disk = f'{WORK}/disk.png'
card(disk, 'On disk (Linux, ~/Downloads)', ['Saved file vs. the note as stored:', check_d.split(': ', 1)[-1],
     'CRLF line endings, trailing spaces, tabs, no final newline: all kept.', 'Name: the title without / : ? (emoji kept), plus .md'])
phone = f'{WORK}/phone.png'
ok = [l.split(': ', 1)[-1] for l in open(f'{AND}/check.txt').read().splitlines() if l.startswith('OK')]
card(phone, 'On the phone (emulator, /sdcard/Download)', ['adb shell: file pulled and compared with the note:', 'Downloads copy: ' + ok[0], 'Shared copy: ' + ok[1], ok[2]])
SCENES = [
    (desk, L['note'] - 1.0, L['dialog'], "This is the real Linux build. The note comes from a stand-in Parachute hub. Its title has a slash, a colon, an emoji and a question mark."),
    (desk, L['dialog'], L['dialog'] + 3.2, "Tap Download dot M D. The system Save dialog opens in Downloads, with the title, made safe, as the file name."),
    (desk, L['saved'] - 1.2, L['saved'] + 1.5, "Save. The app says where the file went."),
    (disk, 0, 3, "On disk, the file is the note exactly as stored, byte for byte."),
    (ANDR, A['01-note'] - 0.5, A['02-saved'] + 0.8, "On Android, the same tap saves straight to Downloads."),
    (ANDR, A['02-saved'] + 0.8, A['04-share-sheet'] + 1.0, "The small menu beside it has Share, and the front matter switch, which is off by default. Share opens the Android share sheet, with the note as a file."),
    (phone, 0, 3, "The phone's Downloads copy has the same bytes. Not tested: the Mac build, and your own devices."),
]
from kokoro_onnx import Kokoro
import soundfile as sf
K = os.path.expanduser('~/.local/share/kokoro')
k = Kokoro(f'{K}/kokoro.onnx', f'{K}/voices.bin')
parts = []
for i, (src, a, b, line) in enumerate(SCENES):
    wav = f'{WORK}/n{i}.wav'
    audio, sr = k.create(line, voice='am_michael', speed=1.05, lang='en-us')
    sf.write(wav, audio, sr)
    length = max(b - a, dur(wav) + 0.7)
    part = f'{WORK}/part{i}.mp4'
    vf = ('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,'
          f'tpad=stop_mode=clone:stop_duration={length:.2f},format=yuv420p')
    src_args = ['-loop', '1', '-t', f'{length:.2f}', '-i', src] if src.endswith('.png') else ['-ss', f'{max(0, a):.2f}', '-t', f'{b - a:.2f}', '-i', src]
    run(*src_args, '-i', wav, '-filter_complex', f'[0:v]{vf}[v];[1:a]aresample=48000,adelay=250|250,apad[a]',
        '-map', '[v]', '-map', '[a]', '-t', f'{length:.2f}', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-ac', '1', part)
    parts.append(part)
    print(i, round(a, 2), round(length, 2), round(dur(wav), 2))
with open(f'{WORK}/parts.txt', 'w') as f:
    f.writelines(f"file '{p}'\n" for p in parts)
run('-f', 'concat', '-safe', '0', '-i', f'{WORK}/parts.txt', '-map_metadata', '-1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', OUT)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'compact', OUT]).decode())
