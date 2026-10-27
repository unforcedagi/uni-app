#!/usr/bin/env python3
"""T-313 walkthrough: made-up people and conversations on a throwaway homeserver (walk.sh starts it).

Registers pat (the viewer, signed in through the app), robin and kit; fills Robin's conversation with what T-313 shows:
a link, two voice messages (Kokoro speech, Ogg Opus as the bridges send it), a photo drawn here, a PDF, a reply with
reactions and a long message; Kit's with a few lines. Run with a Python that has kokoro_onnx, soundfile and PIL (on uni:
~/studio/.venv/bin/python). Everything here is made up.

  seed.py HOMESERVER_URL BOOTSTRAP_TOKEN REG_TOKEN OUT_DIR
Writes OUT_DIR/users.json (made-up passwords) and OUT_DIR/voice*.ogg.
"""
import io, json, os, subprocess, sys, time, urllib.parse, urllib.request

HS, BOOT, REG, OUT = sys.argv[1:5]
PW = 'walk-pw-0123456789'
ROBIN_VOICE = 'af_heart'
# what Robin says in each voice message; narrate.py voices the same words, so the film can play them
VOICES = [
    "Hi Pat, it's Robin. Could you bring the green umbrella on Saturday? It might rain after lunch.",
    "Oh, and the gate code changed. It's four, five, six now. See you then!",
]


def api(method, path, body=None, token=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(HS + path, data=data, method=method)
    req.add_header('Content-Type', ctype)
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        body = e.read()
        if e.code == 401 and b'session' in body:
            return json.loads(body)
        raise SystemExit(f'{method} {path}: {e.code} {body[:300]!r}')


def register(user, token):
    step = api('POST', '/_matrix/client/v3/register', {'username': user, 'password': PW})
    r = api('POST', '/_matrix/client/v3/register', {'username': user, 'password': PW,
            'auth': {'type': 'm.login.registration_token', 'token': token, 'session': step['session']}})
    api('PUT', f"/_matrix/client/v3/profile/{urllib.parse.quote(r['user_id'])}/displayname", {'displayname': user.capitalize() + {'robin': ' Vale', 'kit': ' Sample', 'pat': ' Example'}[user]}, r['access_token'])
    return r['user_id'], r['access_token']


n = 0
def send(token, room, content, kind='m.room.message'):
    global n
    n += 1
    return api('PUT', f'/_matrix/client/v3/rooms/{urllib.parse.quote(room)}/send/{kind}/s{n}', content, token)['event_id']


def upload(token, data, mime, name):
    return api('POST', f'/_matrix/media/v3/upload?filename={urllib.parse.quote(name)}', token=token, raw=data, ctype=mime)['content_uri']


def dm(a_tok, b_id, b_tok, name):
    room = api('POST', '/_matrix/client/v3/createRoom', {'preset': 'trusted_private_chat', 'is_direct': True, 'invite': [b_id], 'name': name}, a_tok)['room_id']
    api('POST', f'/_matrix/client/v3/join/{urllib.parse.quote(room)}', {}, b_tok)
    return room


def voice_clip(text, path):
    from kokoro_onnx import Kokoro
    import soundfile as sf
    k = Kokoro(os.path.expanduser('~/.local/share/kokoro/kokoro.onnx'), os.path.expanduser('~/.local/share/kokoro/voices.bin'))
    audio, sr = k.create(text, voice=ROBIN_VOICE, speed=1.0, lang='en-us')
    wav = path + '.wav'
    sf.write(wav, audio, sr)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '24k', '-ac', '1', path], check=True)
    os.remove(wav)
    return len(audio) / sr


def photo():
    from PIL import Image, ImageDraw
    w, h = 960, 720
    im = Image.new('RGB', (w, h), (232, 238, 244))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 470, w, h], fill=(214, 196, 168))            # the sill
    d.rectangle([60, 40, w - 60, 440], outline=(150, 160, 170), width=10)  # the window
    for i, x in enumerate(range(130, w - 100, 180)):
        d.polygon([(x - 60, 400), (x + 60, 400), (x + 45, 560), (x - 45, 560)], fill=(181, 101, 69))  # pot
        d.rectangle([x - 66, 392, x + 66, 412], fill=(160, 86, 58))
        top = 250 - (i % 3) * 30
        d.line([(x, 400), (x, top)], fill=(70, 130, 60), width=8)
        d.ellipse([x - 70, top - 10, x, top + 30], fill=(96, 170, 80))
        d.ellipse([x, top + 20, x + 70, top + 60], fill=(96, 170, 80))
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=88)
    return b.getvalue(), w, h


def pdf():
    text = 'Planting plan (made up): beans Saturday, tomatoes in May.'
    stream = f'BT /F1 18 Tf 72 720 Td ({text}) Tj ET'.encode()
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
            b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out, offs = b'%PDF-1.4\n', []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    x = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offs)
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)
    return out


pat_id, pat = register('pat', BOOT)
robin_id, robin = register('robin', REG)
kit_id, kit = register('kit', REG)

kitroom = dm(kit, pat_id, pat, 'Kit Sample')
send(kit, kitroom, {'msgtype': 'm.text', 'body': 'Did you get the seeds?'})
send(pat, kitroom, {'msgtype': 'm.text', 'body': 'Yes, thanks! Planting them this week.'})
time.sleep(1)

room = dm(robin, pat_id, pat, 'Robin Vale')
menu = send(robin, room, {'msgtype': 'm.text', 'body': 'Morning! The menu for Saturday is up: https://example.com/garden-lunch/menu'})
send(pat, room, {'msgtype': 'm.text', 'body': 'Looks great, I\'ll bring bread.', 'm.relates_to': {'m.in_reply_to': {'event_id': menu}}})
reply = send(robin, room, {'msgtype': 'm.text', 'body': 'Perfect, thank you!'})
for tok in (robin, pat):
    send(tok, room, {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': reply, 'key': '🍞'}}, 'm.reaction')
for i, words in enumerate(VOICES):
    path = os.path.join(OUT, f'voice{i + 1}.ogg')
    secs = voice_clip(words, path)
    data = open(path, 'rb').read()
    mxc = upload(robin, data, 'audio/ogg', 'Voice message.ogg')
    send(robin, room, {'msgtype': 'm.audio', 'body': 'Voice message.ogg', 'url': mxc,
                       'info': {'mimetype': 'audio/ogg', 'size': len(data), 'duration': int(secs * 1000)},
                       'org.matrix.msc1767.audio': {'duration': int(secs * 1000)}, 'org.matrix.msc3245.voice': {}})
    if i == 0:
        jpg, w, h = photo()
        mxc = upload(robin, jpg, 'image/jpeg', 'seedlings.jpg')
        send(robin, room, {'msgtype': 'm.image', 'body': 'The seedlings are up!', 'filename': 'seedlings.jpg', 'url': mxc,
                           'info': {'mimetype': 'image/jpeg', 'size': len(jpg), 'w': w, 'h': h}})
        doc = pdf()
        mxc = upload(robin, doc, 'application/pdf', 'planting-plan.pdf')
        send(robin, room, {'msgtype': 'm.file', 'body': 'planting-plan.pdf', 'url': mxc, 'info': {'mimetype': 'application/pdf', 'size': len(doc)}})
rota = ('Here is the watering rota for the next few weeks, so nobody has to remember it. '
        + ' '.join(f'Week {k}: {name} waters the beds on Monday and Thursday, and checks the water butt.' for k, name in
                   enumerate(['Robin', 'Pat', 'Kit', 'Sam', 'Rae', 'Lee', 'Jun', 'Mara', 'Robin', 'Pat', 'Kit', 'Sam', 'Rae', 'Lee', 'Jun'], 1))
        + ' If you are away, swap with someone and say so here. Thanks all!')
send(robin, room, {'msgtype': 'm.text', 'body': rota})
send(robin, room, {'msgtype': 'm.text', 'body': 'The forecast says showers after two: https://example.org/weather/saturday'})

json.dump({'pat': {'user_id': pat_id, 'password': PW}, 'voices': VOICES, 'robin_voice': ROBIN_VOICE}, open(os.path.join(OUT, 'users.json'), 'w'))
print('seeded', room)
