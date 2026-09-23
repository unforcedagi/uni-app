import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface TimelineItem {
  source: string;
  ref: string;
  channel: string;
  author: string;
  author_name: string;
  channel_name: string;
  ts: number;
  body: string;
  mentions_me: boolean;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function App() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<TimelineItem[]>("get_timeline", { limit: 50 })
      .then((rows) => {
        setItems(rows);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  return (
    <main className="uni-app">
      <header className="uni-header">
        <h1>Uni</h1>
        <span className="uni-subhead">{items.length} items</span>
      </header>
      <section className="uni-timeline">
        {loading && <p className="uni-status">Loading timeline…</p>}
        {error && <p className="uni-status uni-error">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="uni-status">No items yet. Run sync to populate the database.</p>
        )}
        {items.map((it) => (
          <article
            key={it.ref}
            className={"uni-item" + (it.mentions_me ? " uni-mention" : "")}
          >
            <div className="uni-item-meta">
              <span className="uni-channel">{it.channel_name || it.channel.slice(0, 8)}</span>
              <span className="uni-author">{it.author_name || it.author.slice(0, 8)}</span>
              <time className="uni-time">{formatTime(it.ts)}</time>
            </div>
            <p className="uni-body">{it.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

export default App;
