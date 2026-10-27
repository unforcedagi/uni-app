// T-301/T-302: one quiet strip under the room's header: the area's projects, each a small tab that opens it in place. A project with
// live sessions carries a small live mark. Archived projects sit behind one "Archived" tab at the end (they open the same way, to be
// brought back); a project the vault hasn't given a folder yet is named once, plainly, so it isn't silently missing. Folds to one line,
// remembered on this device.
import { useState } from "react";
import { liveSessions, projectsIn } from "./model";
import { useWork } from "./store";
import "./projects.css";

const FOLD_KEY = "uni.t301.strip.folded";
const readFold = () => { try { return localStorage.getItem(FOLD_KEY) === "1"; } catch { return false; } };

export function ProjectStrip({ areaPath, onOpen }: { areaPath: string; onOpen: (project: string) => void }) {
  const { work } = useWork();
  const [folded, setFoldedState] = useState(readFold);
  const [showArchived, setShowArchived] = useState(false);
  const setFolded = (v: boolean) => { setFoldedState(v); try { localStorage.setItem(FOLD_KEY, v ? "1" : "0"); } catch { /* private storage */ } };
  const area = work.areas.find((a) => a.path === areaPath);
  const gaps = work.gaps.filter((g) => g.areaPath === areaPath);
  // an area whose note names no room has no projects the model can hold: its strip still names them (review finding 7)
  if (!area) return gaps.length ? <section className="ps" aria-label="Projects here" data-place="project-strip"><span className="ps-label">Projects</span>
    <span className="ps-gap">{gaps.map((g) => g.name).join(", ")}: this area has no room yet</span></section> : null;
  const all = projectsIn(work, area.id);
  const projects = all.filter((p) => p.status !== "archived");
  const archived = all.filter((p) => p.status === "archived");
  if (!projects.length && !archived.length && !gaps.length) return null;
  const live = projects.reduce((n, p) => n + liveSessions(work, p.id).length, 0);
  const tab = (p: (typeof all)[number]) => {
    const n = liveSessions(work, p.id).length;
    return <li key={p.id}><button type="button" className={`ps-tab ${n ? "live" : ""} ${p.status}`} data-project={p.id} onClick={() => onOpen(p.id)}
      aria-label={`${p.name}${n ? `, ${n} working` : ""}${p.status === "resting" ? ", resting" : p.status === "archived" ? ", archived" : ""}`}>
      {n > 0 && <i className="ps-dot" aria-hidden="true" />}<span>{p.name}</span>{n > 1 && <small aria-hidden="true">×{n}</small>}
    </button></li>;
  };
  return <section className={`ps ${folded ? "folded" : ""}`} aria-label={`${area.name}'s projects`} data-place="project-strip">
    <button type="button" className="ps-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
      <span className="ps-label">Projects</span>
      {folded && <span className="ps-sum">{projects.length}{live > 0 && <> · <i className="ps-dot" aria-hidden="true" />{live} working</>}</span>}
      <i className="ps-chev" aria-hidden="true" />
    </button>
    {!folded && <ul className="ps-list">
      {projects.map(tab)}
      {archived.length > 0 && <li><button type="button" className="ps-tab ps-more" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>Archived · {archived.length}</button></li>}
      {showArchived && archived.map(tab)}
      {gaps.length > 0 && <li className="ps-gap" title="These projects need a folder in the vault before their sessions show here.">{gaps.map((g) => g.name).join(", ")}: no folder yet</li>}
    </ul>}
  </section>;
}
