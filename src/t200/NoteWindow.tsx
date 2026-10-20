import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import NotePane from "./NotePane";
import { NOTE_CHANNEL, closeSelf } from "./noteWindow";
import { sameHub, type VaultRef } from "../vaultlinks";
import { ALIASES_KEY, resolveNote } from "../noteIdentity";

const aliases = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(ALIASES_KEY) ?? "{}"); } catch { return {}; } };

/** C: the whole window is the note. Quote in reply goes to the room it was opened from, in the main window. */
export default function NoteWindow({ target, room }: { target: VaultRef; room: string }) {
  const [stack, setStack] = useState<VaultRef[]>([target]);
  const [hub, setHub] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  useEffect(() => { invoke<{ hub: string; hub_origins?: string[] }>("journal_config").then((c) => { setHub(c.hub); setOrigins(c.hub_origins ?? []); }).catch(() => {}); }, []);
  useEffect(() => { if (!sent) return; const t = setTimeout(() => setSent(false), 4000); return () => clearTimeout(t); }, [sent]);
  const post = (msg: object) => { const ch = new BroadcastChannel(NOTE_CHANNEL); ch.postMessage(msg); ch.close(); };
  return <main className="t200-window-shell">
    <NotePane shape="window" stack={stack} hub={hub}
      onOpen={(ref, href) => {
        // as in the main window: another hub's note goes to the browser; a known old name opens the note it was renamed to
        if (!sameHub(ref, hub, origins)) { if (href) void invoke("open_link", { url: href }).catch(() => {}); return; }
        setStack((s) => [...s.slice(-19), resolveNote({ ...ref, hub: null }, aliases())]);
      }} onBack={() => setStack((s) => s.slice(0, -1))} onClose={() => void closeSelf()}
      onQuote={(text) => { post({ kind: "quote", room, text }); setSent(true); }} />
    {sent && <div className="toast" role="status">Quoted in your reply, in the main window</div>}
  </main>;
}
