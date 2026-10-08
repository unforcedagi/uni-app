# Writing an area app

An **area app** is one HTML note in the vault, `Areas/<Name>/app` (extension `html`). The Uni app runs
it in a sealed frame and shows it as that area's screen. Edit the note and the screen changes, with no
app release. Example apps: [`techne.html`](techne.html) (calm workbench) and
[`unforced.html`](unforced.html) (client-practice dashboard). Start from one of them.

Publish: create/update the note `Areas/<Name>/app` with `extension: html` and the file as `content`.
It runs only where the in-app **sandbox self-test** has passed for this platform, app version and
webview (Settings → Area apps → Run sandbox self-test), or where the platform is listed in
`LIVE_AREA_PLATFORMS` (`src/areas/gate.ts`, empty by default). Anywhere else, and whenever a self-test
fails, the area shows the default view (note + recent messages + Open room / Open note).

## The sandbox

- The note runs in `<iframe srcdoc sandbox="allow-scripts">`: **no** same-origin, storage, cookies,
  forms, popups or top-navigation. `document.cookie` and `localStorage` throw. Forms do not submit:
  use `<button type="button">` and click handlers, never `<form>`.
- A CSP meta tag is placed before your markup. Do not try to override it:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`
  - Inline `<script>` and `<style>` only. No external scripts, styles, fonts or images (use `data:` URIs or inline SVG).
  - No `fetch`, XHR, WebSocket, `eval` or `new Function`.
  - Your own `<!doctype>` is replaced; `<html>`, `<head>`, `<body>` are fine.
- The host app's own CSP allows only `frame-src about:`, so the frame cannot navigate itself:
  `location = …`, `<meta http-equiv="refresh">`, a clicked `<a>` and `document.write` of a redirect
  are all blocked. If the frame ever loads a second document, the host unmounts it and shows
  "This area app tried to leave its sandbox and was stopped."
- WebRTC (`RTCPeerConnection`, `RTCDataChannel`) is removed before your code runs.
- The frame has no Tauri API and no vault access. Its only door is the bridge below.

**Not fully sealed.** CSP cannot govern WebRTC, and `dns-prefetch`/`preconnect` hints are ignored by
some engines, so those two channels are only best-effort sealed: WebRTC is removed by a script that
code in another realm could in principle bypass (the frame has no child frames to supply one), and
DNS hints are covered by the CSP in the engines we tested but not guaranteed everywhere. Do not
treat the frame as safe for hostile code on a platform that has not passed the self-test.
- Write with `textContent`, never `innerHTML`, for anything that came from a message or note.

## Bridge v1

Requests go to `parent.postMessage(msg, "*")`; replies and events arrive on `window` `message` events.

```js
// request  {bridge:1, id, method, params?}      exact keys only; id is a string, 1–64 chars
// reply    {bridge:1, id, result}  or  {bridge:1, id, error}
// event    {bridge:1, event, data}                 host → app, no id
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = "r" + Math.random().toString(36).slice(2);
    const on = (e) => { const m = e.data; if (!m || m.bridge !== 1 || m.id !== id) return;
      removeEventListener("message", on); "error" in m ? reject(new Error(m.error)) : resolve(m.result); };
    addEventListener("message", on);
    parent.postMessage({ bridge: 1, id, method, params }, "*");
  });
}
```

| Method | Params | Result |
|---|---|---|
| `area.get` | none | `{title, body, metadata, updatedAt}`: the area note (`body` is its markdown) |
| `notes.list` | `{limit?}` ≤ 50 (default 50) | `{notes:[{path, title, updatedAt}]}`, notes under `Areas/<Name>/`, newest first, the app note excluded |
| `note.get` | `{path}` | `{path, content, updatedAt}`. Read-only. `path` must be inside `Areas/<Name>/` (no `..`, no absolute paths, no other areas) |
| `channel.recent` | `{limit?}` ≤ 30 (default 30) | `{messages:[{id, author, content, created_at}]}`, newest first, from the area's room(s) |
| `channel.compose` | `{text}` ≤ 2000 chars | `{ok:true, room}` (`room` is the name of the room that got the draft: the area's first room). Opens that room with `text` in the composer draft (appended after any draft already there). **It never sends**: Aaron presses Send. Needs a user gesture (below) |
| `note.open` | `{ref}`, a path inside `Areas/<Name>/` | `{ok:true}`. Opens the note in Uni's note sheet. Scoped like `note.get`; other refs give `out_of_scope`. Needs a user gesture (below) |

**User gestures.** `channel.compose` and `note.open` move Aaron's view, so they work only right after he
taps or presses a key inside your frame (the host sees focus in the frame plus a live user
activation, about 5 seconds), and at most one of them per 3 seconds. Call them from a click or key
handler, never on load: a call without a gesture gets `needs_gesture`, a second one inside 3 seconds
gets `rate_limited`.

Events: `{bridge:1, event:"theme", data:{text, muted, accent, surface, line, sans, serif, mono}}` arrives
once when the frame loads (and again if the OS light/dark mode changes). Colors are CSS values, fonts are
CSS font stacks. Put them in CSS variables with sensible defaults, as the examples do. The host also
injects Cormorant Garamond and Inter (see Fonts below), so those two always work.

Errors (`error` string): `bad_request`, `bad_version`, `bad_id`, `bad_params`, `unknown_method`,
`too_large`, `rate_limited`, `too_many_pending`, `out_of_scope`, `no_channel`, `needs_gesture`, or a short
message from the host. Any unknown method is an error. Messages with no usable `id` get no reply.

## Limits

- Request ≤ 8 KB serialised; `id` 1–64 chars; only the keys `bridge`, `id`, `method`, `params`.
- ≤ 8 requests pending at once; ≤ 60 messages per 10 seconds, counting **every** message, valid or not.
  Over the limit the host drops messages silently (no reply), so a flood cannot cost the host anything.
- One `channel.compose` or `note.open` per 3 seconds, each after a user gesture.
- Only messages from your own frame are read by the host, and only the methods above exist.

## Authoring checklist

1. Self-contained HTML. Inline CSS/JS. No network.
2. Draw something with character. Use the theme colors and fonts, but the layout is yours.
3. Handle empty, loading and error states for every bridge call (`.catch`).
4. Make it work at 390 px wide and at 1600 px wide.
5. Keep compose honest: say that a draft was made, never that it was sent.

## Fonts

The host injects Cormorant Garamond (400–600, italic 400) and Inter (400–600) into every frame as `data:` `@font-face` rules, so `font-family: Inter` and `"Cormorant Garamond"` just work. No other web fonts can load (`font-src data:` only).
