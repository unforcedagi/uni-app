# Writing an area app

An **area app** is one HTML note in the vault, `Areas/<Name>/app` (extension `html`). The Uni app runs
it in a sealed frame and shows it as that area's screen. Edit the note and the screen changes, with no
app release. Example apps: [`techne.html`](techne.html) (calm workbench) and
[`unforced.html`](unforced.html) (client-practice dashboard). Start from one of them.

Publish: create/update the note `Areas/<Name>/app` with `extension: html` and the file as `content`.
It only runs on platforms in `LIVE_AREA_PLATFORMS` (`src/areas/gate.ts`); other platforms show the
default area view (note + recent messages + Open room / Open note).

## The sandbox

- The note runs in `<iframe srcdoc sandbox="allow-scripts">`: **no** same-origin, storage, cookies,
  forms, popups or top-navigation. `document.cookie` and `localStorage` throw. Forms do not submit:
  use `<button type="button">` and click handlers, never `<form>`.
- A CSP meta tag is placed before your markup. Do not try to override it:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`
  - Inline `<script>` and `<style>` only. No external scripts, styles, fonts or images (use `data:` URIs or inline SVG).
  - No `fetch`, XHR, WebSocket, `eval` or `new Function`.
  - Your own `<!doctype>` is replaced; `<html>`, `<head>`, `<body>` are fine.
- The frame has no Tauri API and no vault access. Its only door is the bridge below.
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
| `channel.compose` | `{text}` ≤ 2000 chars | `{ok:true}`. Opens the area's room with `text` in the composer draft (appended after any draft already there). **It never sends**: Aaron presses Send |
| `note.open` | `{ref}` (a vault path or id) | `{ok:true}`. Opens the note in Uni's note sheet |

Events: `{bridge:1, event:"theme", data:{text, muted, accent, surface, line, sans, serif, mono}}` arrives
once when the frame loads (and again if the OS light/dark mode changes). Colors are CSS values, fonts are
CSS font stacks. Put them in CSS variables with sensible defaults, as the examples do. Fonts are only the
ones installed on the device (the frame cannot load web fonts).

Errors (`error` string): `bad_request`, `bad_version`, `bad_id`, `bad_params`, `unknown_method`,
`too_large`, `rate_limited`, `too_many_pending`, `out_of_scope`, `no_channel`, or a short message
from the host. Any unknown method is an error. Messages with no usable `id` get no reply.

## Limits

- Request ≤ 8 KB serialised; `id` 1–64 chars; only the keys `bridge`, `id`, `method`, `params`.
- ≤ 8 requests pending at once; ≤ 60 requests per 10 seconds. Excess requests get an error reply.
- Only messages from your own frame are read by the host, and only the methods above exist.

## Authoring checklist

1. Self-contained HTML. Inline CSS/JS. No network.
2. Draw something with character. Use the theme colors and fonts, but the layout is yours.
3. Handle empty, loading and error states for every bridge call (`.catch`).
4. Make it work at 390 px wide and at 1600 px wide.
5. Keep compose honest: say that a draft was made, never that it was sent.

## Fonts

The host injects Cormorant Garamond (400–600, italic 400) and Inter (400–600) into every frame as `data:` `@font-face` rules, so `font-family: Inter` and `"Cormorant Garamond"` just work. No other web fonts can load (`font-src data:` only).
