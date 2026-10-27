#!/usr/bin/env python3
"""T-313 walkthrough: the narration, one line per step, each tagged with what walk.spec.ts does as it starts. Robin's line
is the voice message itself (the same words and Kokoro voice seed.py made it with), so the film plays it as it plays on screen.

  script.py USERS_JSON OUT_LINES_JSON"""
import json, os, sys
users = json.load(open(sys.argv[1]))
robin = users['voices'][0]
lines = [
    {'tag': 'open', 'text': "Here's Messages in the Uni app, with made-up people on a test homeserver. Let's open Robin's conversation."},
    {'tag': 'link', 'text': "Links are tappable now. A tap opens the page in your browser."},
    {'tag': 'voice', 'text': "Robin sent a voice message. It plays right here."},
    {'tag': 'robin', 'text': robin, 'voice': users['robin_voice'], 'speed': 1.0, 'gap': 0.3},
    {'tag': 'words', 'text': "Under it are the words. Whisper turns the clip into text on your own machine, once. After that the words are kept, encrypted, with your messages.", 'gap': 0.6},
    {'tag': 'scrub', 'text': "Drag to go back to any spot, and tap to pause."},
    {'tag': 'photo', 'text': "Photos show in place. Tap one to see it large."},
    {'tag': 'file', 'text': "A file opens in whatever app your device uses for it."},
    {'tag': 'reply', 'text': "A reply shows what it answers. Tap the quote to jump back to it. Reactions sit under the message."},
    {'tag': 'long', 'text': "And a long message folds, with Read more."},
    {'tag': 'end', 'text': "That's the pass: links, voice messages with their words, photos, files, replies and reactions. Tested at phone, Daylight and desktop sizes, and against a real homeserver."},
]
# a run can end on a note for its one viewer (what's still to do on their side), kept out of the repo
if os.environ.get('T313_END_LINE'):
    lines[-1] = {'tag': 'end', 'text': os.environ['T313_END_LINE']}
json.dump(lines, open(sys.argv[2], 'w'), indent=1)
