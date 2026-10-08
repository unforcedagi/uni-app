// The srcdoc for a sealed interface. Pure: data in, string out.

export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;

// WebRTC ignores CSP. This removes it from the app's own realm before app code
// runs. It is NOT a seal: a srcdoc child frame is a fresh realm. The seal is a
// webview with WebRTC off, proven by the self-test's child-frame check.
const RTC_NAMES = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"];
const NO_RTC = `<script>(function(){var n=${JSON.stringify(RTC_NAMES)};for(var i=0;i<n.length;i++)try{Object.defineProperty(window,n[i],{value:undefined,writable:false,configurable:false})}catch(e){}})()</script>`;

/** Keep a script body from closing its own tag or opening an HTML comment. */
const inlineScript = (code: string) => `<script>${code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")}</script>`;

/**
 * The CSP meta is the first thing in the document, so the policy applies
 * before any kit or app markup; then the WebRTC removal, the kits, the host
 * fonts (`headExtra`) and the app. A leading doctype is dropped (ours replaces
 * it); the parser puts the meta in an implicit <head> and merges the app's own
 * <html>/<head> tags after it.
 */
export function buildSrcdoc(html: string, opts: { kitSource: string; headExtra: string }): string {
  const body = html.replace(/^﻿/, "").replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html>${CSP_META}${NO_RTC}${opts.kitSource ? inlineScript(opts.kitSource) : ""}${opts.headExtra}${body}`;
}
