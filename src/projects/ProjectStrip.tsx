// T-301: one quiet strip under the room's header: the area's projects, each a small tab that opens it in place. A project with a live
// session carries a small live mark. Folds to one line, remembered on this device.
import { useState } from "react";
import { liveSessions, projectsIn, type Area } from "./model";
import { useWork } from "./store";
import "./projects.css";

const FOLD_KEY = "uni.t301.strip.folded";
const readFold = () => { try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; } };

export function ProjectStrip({ area, onOpen }: { area: Area; onOpen: (project: string) => void }) {
  const work = useWork();
  const [folded, setFoldedState] = useState(readFold);
  const setFolded = (v: boolean) => { setFoldedState(v); try { localStorage.setItem(FOLD_KEY, v ? "1" : "0"); } catch { /* private storage */ } };
  const projects = projectsIn(work, area.id).filter((p) => p.status !== "done");
  if (!projects.length) return null;
  const live = projects.reduce((n, p) => n + liveSessions(work, p.id).length, 0);
  return <section className={`ps ${folded ? "folded" : ""}`} aria-label={`${area.name}'s projects`} data-proto="project-strip">
    <button type="button" className="ps-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
      <span className="ps-label">Projects</span>
      {folded && <span className="ps-sum">{projects.length}{live > 0 && <> · <i className="ps-dot" aria-hidden="true" />{live} working</>}</span>}
      <i className="ps-chev" aria-hidden="true" />
    </button>
    {!folded && <ul className="ps-list">{projects.map((p) => {
      const n = liveSessions(work, p.id).length;
      return <li key={p.id}><button type="button" className={`ps-tab ${n ? "live" : ""} ${p.status}`} data-project={p.id} onClick={() => onOpen(p.id)}
        aria-label={`${p.name}${n ? `, ${n} working` : ""}${p.status === "resting" ? ", resting" : ""}`}>
        {n > 0 && <i className="ps-dot" aria-hidden="true" />}<span>{p.name}</span>{n > 1 && <small aria-hidden="true">×{n}</small>}
      </button></li>;
    })}</ul>}
  </section>;
}
