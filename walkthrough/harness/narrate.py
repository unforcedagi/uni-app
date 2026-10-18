#!/usr/bin/env python3
"""T-172 walkthrough: scenes cut from the real recordings, one Kokoro line each (am_michael),
the picture held on its last frame while a line runs long; relay-safe MP4."""
import os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
OUT = '/home/uni/Code/wt/t172-media/WALKTHROUGH.mp4'
DESK, ANDR = f'{D}/desktop.mp4', f'{D}/../android-rec.mp4'
SCENES = [
    (DESK, 0.0, 4.9, "This is Uni's chat, the real Linux build, with a 35 megabyte video in a room. Before this fix, anything over 25 megabytes said: failed, tap to retry. Every time."),
    (DESK, 4.9, 8.0, "Tap play. The app now streams the file into its cache on disk, checking its fingerprint as it arrives, and shows the size while it downloads."),
    (DESK, 8.0, 14.4, "Then it plays straight from that file, through a local address only this app knows. The video never sits whole in the page's memory."),
    (DESK, 14.4, 20.8, "Seeking to 45 seconds asks for just that part of the file."),
    (DESK, 20.8, 29.0, "A file over the new 500 megabyte limit now says exactly that, instead of a silent retry."),
    (ANDR, 0.0, 21.0, "Here is the same path on an Android 13 emulator, the Daylight's Android version. The clip plays, then jumps to 45 seconds. It's driven directly, because the emulator isn't signed in."),
    (ANDR, 20.9, 21.0, "Not tested yet: your Daylight itself, and the Mac. Next step: install this build on the Daylight and play one of the real class videos."),
]
VO = f'{D}/vo'; os.makedirs(VO, exist_ok=True)

def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]))

from kokoro_onnx import Kokoro
import soundfile as sf
K = os.path.expanduser('~/.local/share/kokoro')
k = Kokoro(f'{K}/kokoro.onnx', f'{K}/voices.bin')
parts = []
for i, (src, a, b, line) in enumerate(SCENES):
    wav = f'{VO}/n{i}.wav'
    if not os.path.exists(wav):
        audio, sr = k.create(line, voice='am_michael', speed=1.0, lang='en-us')
        sf.write(wav, audio, sr)
    length = max(b - a, dur(wav) + 0.8)
    part = f'{D}/part{i}.mp4'
    vf = ('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,'
          f'tpad=stop_mode=clone:stop_duration={length:.2f},format=yuv420p')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{a}', '-t', f'{b - a:.2f}', '-i', src, '-i', wav,
                    '-filter_complex', f'[0:v]{vf}[v];[1:a]aresample=48000,adelay=300|300,apad[a]',
                    '-map', '[v]', '-map', '[a]', '-t', f'{length:.2f}', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-ac', '1', part], check=True)
    parts.append(part)
    print(i, round(length, 2), round(dur(wav), 2))
with open(f'{D}/parts.txt', 'w') as f:
    f.writelines(f"file '{p}'\n" for p in parts)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{D}/parts.txt',
                '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
                '-metadata:s:v', 'handler_name=', '-metadata:s:a', 'handler_name=', '-c:v', 'libx264', '-x264-params', 'no-info=1',
                '-pix_fmt', 'yuv420p', '-crf', '24', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', OUT], check=True)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type:format=duration,size', '-of', 'compact', OUT]).decode())
