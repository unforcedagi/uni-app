#!/usr/bin/env python3
"""T-294 walkthrough: the film walk.spec.ts recorded, cut at its scene marks, one Kokoro line per scene (am_michael), the picture
held on its last frame while a line runs long. Run with a Python that has kokoro_onnx + soundfile (on uni: ~/studio/.venv/bin/python).
Writes ../../WALKTHROUGH.mp4 (git-ignored)."""
import glob, json, os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(f'{D}/../../WALKTHROUGH.mp4')
FILM = glob.glob(f'{D}/runs/**/video.webm', recursive=True)[0]
MARKS = json.load(open(f'{D}/runs/marks.json'))
LINES = {
    'room': "This is the Uni app at the Daylight's size, running in a browser with made-up rooms. I'm in the ATLAS room, reading back through older messages, with a reply half written.",
    'messages': "Now I switch to Messages. Before this fix, tapping Uni from here took you to Uni's home. The room, where you were reading, and the reply were gone.",
    'back': "Now tap Uni. It comes straight back to ATLAS, at the same message, with the half-written reply still in the box.",
    'msgs-own': "Messages keeps its own place the same way. Open Kit's conversation, scroll back, start a reply, go to Uni, and come back. Same conversation, same spot, same reply.",
    'restart': "It holds when the system closes the app, too. Here the app is put away in Messages and started again. Messages reopens, and Uni still goes back to the room, at the same message.",
    'home': "If you're already in Uni, tapping Uni still takes you home, as before. This was tested in the browser at Daylight, Mac and phone sizes, not on the Daylight itself yet. Next: put this build on the Daylight and try it.",
}
order = sorted((t, k) for k, t in MARKS.items())
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
    length = max(b - a, dur(wav) + 0.8)
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
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{D}/runs/parts.txt',
                '-map_metadata', '-1', '-map_chapters', '-1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24',
                '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', OUT], check=True)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'compact', OUT]).decode())
