// The app's shim for the vendored ask library (src/ask/README.md): two built-ins it uses that an older webview may lack. Imported first by
// src/main.tsx. A no-op wherever they exist.
type WithWellFormed = { isWellFormed?: () => boolean };
if (typeof (String.prototype as WithWellFormed).isWellFormed !== "function") {
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true, writable: true,
    // well formed: no lone surrogate (a high one not followed by a low one, or a low one with no high one before it)
    value(this: string) { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(this)); },
  });
}
if (typeof (Object as { hasOwn?: unknown }).hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", { configurable: true, writable: true, value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k) });
}
export {};
