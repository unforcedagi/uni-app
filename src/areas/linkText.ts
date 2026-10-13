// Text with links in it (pure, unit-tested in scripts/navtree.test.ts): a raw URL reads as its domain ("example.com"), or "link" when it has
// none, and stays clickable. Only http(s) and bare www links; anything else is left as the text it is.
export type TextPart = { text: string } | { url: string; label: string };

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const TRAIL = /[.,;:!?]+$/;

export function linkLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return /\./.test(host) ? host : "link";
  } catch { return "link"; }
}

export function splitLinks(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(TRAIL, "");
    const start = m.index ?? 0;
    const url = /^www\./i.test(raw) ? `https://${raw}` : raw;
    try { if (!/^https?:$/.test(new URL(url).protocol)) continue; } catch { continue; }
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ url, label: linkLabel(url) });
    at = start + raw.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
