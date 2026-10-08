// The code injected into every sealed frame, after the CSP meta: `window.uni`.
// It runs inside the frame, so it is a string. Kept free of backticks and `${`.
//   uni.ready()                      → Promise of the host's context (area name, title, purpose…)
//   uni.frameFetch(url, init)        → fetch over the frame (pfr envelope), what VaultClient uses
//   uni.VaultClient / uni.vault      → surface-client's VaultClient on frameFetch (read-only subset)
//   uni.chat.recent(limit) / .draft(text, room?)
//   uni.note.open(path)
//   uni.theme.get() / .on(cb)        → host colours; CSS vars --text, --accent… are also set on <html>
// In-page #anchor links scroll in place. chat.draft and note.open only create a pending suggestion that the user must tap in the host UI.

export const FRAME_KIT = String.raw`(function () {
  var pending = {}, fetches = {}, n = 0, themeCbs = [], theme = null, readyRes;
  var readyP = new Promise(function (r) { readyRes = r; });
  function post(m) { parent.postMessage(m, "*"); }
  function timeout(table, id, rej) { setTimeout(function () { if (table[id]) { delete table[id]; rej(new Error("timeout")); } }, 20000); }
  function call(ns, method, params) {
    return new Promise(function (res, rej) {
      var id = "k" + (++n); pending[id] = { res: res, rej: rej };
      post({ uni: 1, id: id, ns: ns, method: method, params: params || {} });
      timeout(pending, id, rej);
    });
  }
  function applyTheme(t) {
    theme = t; var r = document.documentElement.style;
    ["text", "muted", "accent", "surface", "line", "sans", "serif", "mono"].forEach(function (k) { if (t && t[k]) r.setProperty("--" + k, t[k]); });
    themeCbs.forEach(function (f) { try { f(t); } catch (e) {} });
  }
  addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data; if (!m || typeof m !== "object") return;
    if (m.pfr === 1) {
      var f = fetches[m.id]; if (!f) return; delete fetches[m.id];
      try { f.res(new Response(m.body, { status: m.status, statusText: m.statusText, headers: m.headers })); } catch (err) { f.rej(err); }
      return;
    }
    if (m.uni !== 1) return;
    if (m.event === "ready") { if (m.data && m.data.theme) applyTheme(m.data.theme); readyRes(m.data); return; }
    if (m.event === "theme") { applyTheme(m.data); return; }
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    if (m.error) { var er = new Error(m.error.message || m.error.code); er.code = m.error.code; p.rej(er); } else p.res(m.result);
  });
  function frameFetch(input, init) {
    init = init || {};
    return new Promise(function (res, rej) {
      var url = typeof input === "string" ? input : String(input && input.url ? input.url : input);
      var u; try { u = new URL(url); } catch (e) { rej(new TypeError("bad url")); return; }
      var headers = {};
      var h = init.headers;
      if (h && typeof h.forEach === "function") h.forEach(function (v, k) { headers[k] = String(v); });
      else if (h) Object.keys(h).forEach(function (k) { headers[k] = String(h[k]); });
      delete headers.Authorization; delete headers.authorization;
      var id = "f" + (++n); fetches[id] = { res: res, rej: rej };
      post({ pfr: 1, channel: "vault", id: id, method: String(init.method || "GET"), path: u.pathname + u.search, headers: headers, body: typeof init.body === "string" ? init.body : null });
      timeout(fetches, id, rej);
    });
  }
  // In a srcdoc frame a bare "#section" link resolves against the *host's* URL, so the browser would navigate the
  // frame away (the host CSP blocks it, and the host would stop the app). Scroll in place instead.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    var h = a && a.getAttribute("href");
    if (typeof h !== "string" || h.charAt(0) !== "#") return;
    e.preventDefault();
    var id = h.slice(1); try { id = decodeURIComponent(id); } catch (err) {}
    var t = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
    if (t) t.scrollIntoView(); else if (!id) window.scrollTo(0, 0);
  }, true);
  var uni = {
    contract: 1,
    ready: function () { return readyP; },
    frameFetch: frameFetch,
    call: call,
    chat: {
      recent: function (limit) { return call("chat", "recent", limit == null ? {} : { limit: limit }); },
      draft: function (text, room) { var p = { text: text }; if (room != null) p.room = room; return call("chat", "draft", p); }
    },
    note: { open: function (ref) { return call("note", "open", { ref: ref }); } },
    theme: {
      get: function () { return call("theme", "get", {}); },
      on: function (cb) { themeCbs.push(cb); if (theme) cb(theme); }
    }
  };
  var VC = window.__UniVC && window.__UniVC.VaultClient;
  if (VC) {
    uni.VaultClient = VC;
    uni.vault = new VC({ vaultUrl: "https://uni.invalid", accessToken: "frame", fetchImpl: frameFetch });
  }
  Object.freeze(uni.chat); Object.freeze(uni.note); Object.freeze(uni.theme);
  Object.defineProperty(window, "uni", { value: Object.freeze(uni), writable: false, configurable: false });
})();`;
