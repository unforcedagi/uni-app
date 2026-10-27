#!/usr/bin/env python3
"""T-319 walkthrough (after T-304's): the film walk.spec.ts recorded, cut at its scene marks, one Kokoro line per scene (am_michael), the picture held
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
    'stale': "This is the Uni app with made-up data. At the bottom of the front door is the Claude usage line. Its last reading here is twenty-eight hours old, so instead of showing old numbers as if they were current, it says so plainly.",
    'refresh': "The launcher now writes that reading every fifteen minutes. The app reads it again on its own, and Refresh reads it right now. The line comes back with its numbers, and says how old they are.",
    'card': "The full card says the same: as of two minutes ago, with its own Refresh. An old reading there is marked as old and its numbers fade.",
    'one-old': "Each account's reading counts on its own. Here account A's meter has stopped while B's keeps going, so A says so on its own row, and the line says it too, instead of borrowing B's freshness.",
    'long': "Now a long Claude Code session. Its live view opens on the newest sixty steps, as before.",
    'earlier': "Load earlier steps brings in the two hundred before them, and keeps your place where they meet.",
    'first': "Scrolling to the top loads the next part, back to the session's very first step. The launcher keeps up to five thousand steps per session, in parts, and anything that looks like a key is still hidden.",
    'end': "That's the browser build with made-up data, tested at phone, Daylight and desktop sizes. The longer history comes from a launcher change on its own branch; it isn't live until that's merged.",
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
