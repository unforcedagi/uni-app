// T-335 the Studio applet: what Uni has pinned for you to look at on the media Studio board (asks of kind "look" with a
// link; studioCore.ts picks them). The board itself still lives on the box and opens in the browser.
import type { StudioLook } from "./studioCore.ts";
import "./applets.css";

export function Studio({ looks, onOpenLink }: { looks: StudioLook[]; onOpenLink: (link: string) => void }) {
  if (!looks.length) return <div className="sh-ap-calm">
    <p className="sh-ap-calm-head">Nothing is pinned for you to look at.</p>
    <p>The board itself still lives on the box and opens in the browser.</p>
  </div>;
  return <ul className="sh-ap-looks">
    {looks.map((l) => <li key={l.id} className="sh-ap-look">
      <h3>{l.what}</h3>
      {l.why && <p className="sh-ap-look-why">{l.why}</p>}
      <div className="sh-ap-look-foot">
        {l.roomName && <span className="sh-ap-look-room">{l.roomName}</span>}
        <button type="button" className="sh-ap-btn" onClick={() => onOpenLink(l.link)}>Open on the board</button>
      </div>
    </li>)}
  </ul>;
}
