// The app's shim for the vendored ask library (src/ask/README.md): two built-ins it uses that an older webview may lack. Imported first by
// src/main.tsx. A no-op wherever they exist.
type WithWellFormed = { isWellFormed?: () => boolean };
if (typeof (String.prototype as WithWellFormed).isWellFormed !== "function") {
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true, writable: true,
    // well formed: no lone surrogate (a high one not followed by a low one, or a low one with no high one before it)
    // (a scan by hand, not a regex: a lookbehind is itself missing from the webviews this shim is for)
    value(this: string) {
      const t = String(this);
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) { const n = t.charCodeAt(i + 1); if (n >= 0xdc00 && n <= 0xdfff) { i++; continue; } return false; }
        if (c >= 0xdc00 && c <= 0xdfff) return false;
      }
      return true;
    },
  });
}
if (typeof (Object as { hasOwn?: unknown }).hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", { configurable: true, writable: true, value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k) });
}
export {};
