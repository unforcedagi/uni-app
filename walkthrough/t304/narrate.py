#!/usr/bin/env python3
"""T-304 walkthrough: the film walk.spec.ts recorded, cut at its scene marks, one Kokoro line per scene (am_michael), the picture held
on its last frame while a line runs long, over a quiet bed of the studio's own synthesized track (First Light: oscillators and noise,
no samples). Run with a Python that has kokoro_onnx + soundfile (on uni: ~/studio/.venv/bin/python). Writes ../../WALKTHROUGH.mp4
(git-ignored). MUSIC=<file> picks another bed."""
import glob, json, os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(f'{D}/../../WALKTHROUGH.mp4')
FILM = glob.glob(f'{D}/runs/**/video.webm', recursive=True)[0]
MARKS = json.load(open(f'{D}/runs/marks.json'))
MUSIC = os.environ.get('MUSIC', os.path.expanduser('~/studio/tracks/first_light.mp3'))
LINES = {
    'door': "This is the Uni app at the Daylight's size, with made-up rooms. Workshop says three working: two Claude Code sessions, and Uni answering a message I just sent there. Before, that mark only counted sessions.",
    'project': "I open the co-op site project. Its sessions are listed as before, but now every line opens.",
    'live': "This one is working. It opens to a live view: each step it takes, and what it writes, newest at the bottom. Anything that looks like a key is hidden.",
    'arrives': "While it's open, new steps come in on their own, about every fifteen seconds. Here it moves on to writing its report.",
    'stopped': "An older session didn't finish. Now it says why: it was stopped on purpose.",
    'finished': "A finished one shows its report in plain words: what it did, what it left, with the link to open, and its steps if you want them.",
    'limit': "This one ran out of room. The Claude account hit its session limit, and it says when it will pick up again by itself.",
    'needs': "And this one needs me. It shows the exact question it stopped on.",
    'answer': "Answer in Workshop puts a reply in the room's message box, saying which session and what it asked. Nothing is sent until I send it.",
    'end': "That's the browser build with made-up data, tested at phone, Daylight and desktop sizes. The steps come from a change to the launcher on its own branch; it isn't live until that's merged.",
}
order = sorted((t, k) for k, t in MARKS.items())
order.append((order[-1][0] + 1.0, '_'))
VO = f'{D}/runs/vo'; os.makedirs(VO, exist_ok=True)

def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]))

from kokoro_onnx import Kokoro
import soundfile as sf
K = os.path.expanduser('~/.local/share/kokoro')
k = Kokoro(f'{K}/kokoro.onnx', f'{K}/voices.bin')
parts = []
for i, ((a, key), (b, _)) in enumerate(zip(order, order[1:])):
    wav = f'{VO}/n{i}.wav'
    audio, sr = k.create(LINES[key], voice='am_michael', speed=1.05, lang='en-us')
    sf.write(wav, audio, sr)
    length = max(b - a, dur(wav) + 0.9)
    part = f'{D}/runs/part{i}.mp4'
    vf = ('scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,'
          f'tpad=stop_mode=clone:stop_duration={length:.2f},format=yuv420p')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{a}', '-t', f'{b - a:.2f}', '-i', FILM, '-i', wav,
                    '-filter_complex', f'[0:v]{vf}[v];[1:a]aresample=48000,adelay=300|300,apad[a]',
                    '-map', '[v]', '-map', '[a]', '-t', f'{length:.2f}', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-ac', '1', part], check=True)
    parts.append(part)
    print(key, round(b - a, 2), round(length, 2), round(dur(wav), 2))
with open(f'{D}/runs/parts.txt', 'w') as f:
    f.writelines(f"file '{p}'\n" for p in parts)
voiced = f'{D}/runs/voiced.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{D}/runs/parts.txt', '-c', 'copy', voiced], check=True)
total = dur(voiced)
# the bed: quiet, looped if short, faded in and out, and pulled down further while the voice speaks
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', voiced, '-stream_loop', '-1', '-i', MUSIC,
                '-filter_complex', f'[1:a]aresample=48000,volume=0.16,afade=t=in:d=2,afade=t=out:st={max(0, total - 3):.2f}:d=3,atrim=0:{total:.2f}[m];'
                '[0:a]aresample=48000,asplit[v1][v2];[m][v2]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[duck];'
                '[v1][duck]amix=inputs=2:duration=first:normalize=0[a]',
                '-map', '0:v', '-map', '[a]', '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24',
                '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', OUT], check=True)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'compact', OUT]).decode())
