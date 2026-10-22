import { useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard";

/** T-132: a fenced code block in a message: its language (when the fence names one) and a Copy that takes the code exactly as written.
 *  When the clipboard refuses, the code opens in a selected, read-only box to copy by hand. Language and code are only ever text. */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const manual = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (state === "failed") { manual.current?.focus(); manual.current?.select(); } }, [state]);
  async function copy() {
    clearTimeout(timer.current);
    const ok = await copyText(code, "Code copied");
    setState(ok ? "copied" : "failed");
    if (ok) timer.current = setTimeout(() => setState("idle"), 2000);
  }
  const what = lang ? `${lang} code` : "code";
  return <div className="md-code">
    <div className="md-code-bar">
      {lang && <span className="md-code-lang" title={lang}>{lang}</span>}
      <button type="button" className="md-code-copy" data-state={state} onClick={() => void copy()}
        aria-label={state === "copied" ? `Copied ${what}` : `Copy ${what}`}>{state === "copied" ? "Copied" : "Copy"}</button>
    </div>
    {/* focusable so a keyboard can scroll a long line sideways */}
    <pre className="md-pre" tabIndex={0}><code>{code}</code></pre>
    {state === "failed" && <div className="md-code-manual">
      <p role="alert">Couldn't copy automatically. The code is selected below: press Ctrl+C (⌘C on a Mac), or long-press it and choose Copy.</p>
      <textarea ref={manual} readOnly value={code} aria-label={`The ${what}, to copy by hand`} spellCheck={false} wrap="off"
        rows={Math.min(8, code.split("\n").length)} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="md-code-done" onClick={() => setState("idle")}>Done</button>
    </div>}
  </div>;
}
