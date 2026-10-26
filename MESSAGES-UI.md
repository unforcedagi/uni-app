# Messages: each network, or all of them, one tap apart

A proposal for T-294. No code yet. The names and messages below are made up.

## What you get

Messages gets a row of tabs along its top: **All**, then one per linked network (WhatsApp, Signal, Telegram,
Google Messages, Matrix…). **All** is one inbox: every conversation from every network, newest first. A network's
tab is the same list with only that network's conversations in it. One tap switches, and the list keeps your place.

Each row in **All** carries a small network mark in words (`WA`, `SIG`, `TG`), so you can tell which app Sam wrote
from without colour. On the Daylight, shape and word do the work, and nothing moves.

## Sketch (Daylight, landscape)

```
┌────┬──────────────────────────────────────────────────────────────────────────────┐
│ ✦  │  Messages                                                    ● live          │
│Uni │ ┌──────────────────────────────────────────────────────────────────────────┐ │
│    │ │ [ All 4 ]  WhatsApp 2   Signal   Telegram 2   Matrix        + Link        │ │
│ ✉  │ └──────────────────────────────────────────────────────────────────────────┘ │
│Mail│  CONVERSATIONS               │  Sam Example                  WA · ENCRYPTED │
│    │ ──────────────────────────── │ ───────────────────────────────────────────── │
│ ▦  │  SE  Sam Example     WA 9:41 │                Yesterday                      │
│Cal │      See you at noon       2 │  Sam: Are we still on for lunch?              │
│    │  KS  Kit Sample     TG  9:02 │                     You: Yes, noon works.     │
│ ☰  │      You: Thanks!            │                Today                          │
│Msgs│  BF  Book club      WA  Mon  │  Sam: See you at noon                         │
│    │      Rae: Chapter 4 next     │                                               │
│    │  LL  Lee Lantern   SIG  Sun  │ ┌──────────────────────────────────────────┐  │
│    │      Voice message           │ │ Message Sam Example (WhatsApp)     Send  │  │
│    │                              │ └──────────────────────────────────────────┘  │
└────┴──────────────────────────────┴───────────────────────────────────────────────┘
 [ All 4 ] = the tab you're on, with how many conversations have something unread
```

On a phone the tabs scroll sideways above the list. Tapping a conversation fills the screen; Back returns to the
same tab and spot in the list.

## How it works, in plain terms

- **Which network a conversation is from.** Each bridge marks the rooms it makes (the Matrix `m.bridge` state event, MSC2346,
  which the mautrix WhatsApp, Signal and Telegram bridges set). The Rust core already reads every room; it would add a
  `network` field to each row. A room with no bridge mark is a plain Matrix conversation.
- **The tabs come from what is linked.** The Link screen already knows each network's state. A network shows as a
  tab once it is linked; one that needs attention shows a `!` on its tab, and tapping that opens its Link card.
- **One list, filtered.** All and each network are the same list with a filter. Nothing is fetched twice, unread
  counts add up, and a new message lands in All and its network's tab at once.
- **Each tab remembers its place.** The last conversation open and the scroll spot, per tab, the way T-294 makes the
  app remember the room you were in. Coming back to Messages lands on the tab you left.
- **Writing goes back the way it came.** The composer names the network ("Message Sam Example (WhatsApp)"), so you
  always know which app your reply goes out on.

## Beside Uni's rooms

Uni's rooms and Messages are the two sides of the app, and the rail is the switch between them:

- **Uni** (the rooms): you, Uni and the agents, the work, the areas. Uni reads these.
- **Messages**: you and other people, on their networks. Uni can't read these, and every conversation says so.

Each side keeps its own place. Going from a room to Messages and back lands you in the same room, at the same spot,
with your draft (T-294). Going the other way does the same for Messages. Nothing from Messages appears in Uni's
rooms unless you bring it there yourself: "Bring Uni in" (in the T-278 design) stays a deliberate step per conversation.

## Questions for you

1. Should **All** be the default, or the network you used last?
2. Should group chats get their own tab, or stay mixed in with people?
3. Is a word mark (`WA`, `SIG`, `TG`) enough, or do you want each network's own icon?
4. Should a network you rarely use fold into a "More" tab, so the row stays short on the phone?
