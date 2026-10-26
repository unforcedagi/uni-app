// T-301/T-302: the front door. Tapping Uni shows every area's room, each with one line on where it stands. Calm: a name, a line, when
// the room last talked, and a small mark when sessions are working there. No counts of tasks, no ids. Under them, one quiet line on
// the Claude accounts, which opens the full card.
import { liveInArea, span } from "./model";
import { useWork } from "./store";
import { UsageLine } from "./UsageLine";
import "./projects.css";

export type Door = { path: string; name: string; slug: string | null; stands: string | null; lastTs: number | null };

const today = () => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

/** When the room last talked, in words ("talked 3 h ago"). */
const talked = (now: number, ts: number) => { const s = span(now - ts * 1000); return s === "just now" ? "talking now" : `talked ${s} ago`; };

export function FrontDoor({ doors, onOpen }: { doors: readonly Door[]; onOpen: (path: string) => void }) {
  const { work } = useWork();
  const now = Date.now();
  const areaAt = new Map(work.areas.map((a) => [a.path, a]));
  return <div className="fd" data-place="front-door">
    <header className="fd-head">
      <p className="fd-date">{today()}</p>
      <h1 className="fd-title">Uni</h1>
      <p className="fd-sub">Your rooms</p>
    </header>
    <nav aria-label="Rooms"><ul className="fd-doors">{doors.map((d) => {
      const a = areaAt.get(d.path);
      const live = a ? liveInArea(work, a.id).length : 0;
      return <li key={d.path}>
        <button type="button" className="fd-door" data-path={d.path} onClick={() => onOpen(d.path)}
          aria-label={`${d.name}${live ? `, ${live} working` : ""}${d.stands ? `. ${d.stands}` : ""}`}>
          <span className="fd-name">{d.name}</span>
          {live > 0 && <span className="fd-live" title={`${live} session${live === 1 ? "" : "s"} working`}><i aria-hidden="true" />{live} working</span>}
          {d.stands && <span className="fd-stands">{d.stands}</span>}
          <span className="fd-foot">{d.slug && <span className="fd-slug">#{d.slug}</span>}{d.lastTs && <span className="fd-when">{talked(now, d.lastTs)}</span>}</span>
        </button>
      </li>;
    })}</ul></nav>
    <UsageLine />
  </div>;
}
