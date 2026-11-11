// T-335 the shape: the three places. A bottom bar on a phone, the same nav as a left rail on a wide screen (shape.css).
import type { ReactNode } from "react";
import { JournalIcon, MoreIcon, UniIcon } from "../Icons";
import "./shape.css";

export type Place = "rooms" | "journal" | "applets";
export type BarProps = {
  /** Where you are. */
  place: Place;
  /** What wants you (homeCore `wantsCount`): the Rooms count. */
  wants: number;
  /** The applets' counts summed: the Applets count. */
  applets: number;
  onRooms(): void;
  onJournal(): void;
  onApplets(): void;
  /** The applets drawer is open over the place: Applets is the current one while it is. */
  drawerOpen?: boolean;
};

const short = (n: number) => (n > 99 ? "99+" : String(n));

export function Bar({ place, wants, applets, onRooms, onJournal, onApplets, drawerOpen = false }: BarProps) {
  const here = drawerOpen ? "applets" : place;
  const item = (p: Place, label: string, icon: ReactNode, count: number, countWords: string, on: () => void) =>
    <button type="button" className={`sh-place sh-place-${p}`} aria-current={here === p ? "page" : undefined} onClick={on}
      aria-label={count > 0 ? `${label}, ${count} ${countWords}` : undefined}>
      <i aria-hidden="true">{icon}</i>
      <span className="sh-place-label">{label}</span>
      {count > 0 && <span className="sh-count" aria-hidden="true">{short(count)}</span>}
    </button>;
  return <nav className="sh-bar" aria-label="Places">
    {item("rooms", "Rooms", <UniIcon />, wants, wants === 1 ? "thing wants you" : "things want you", onRooms)}
    {item("journal", "Journal", <JournalIcon />, 0, "", onJournal)}
    {item("applets", "Applets", <MoreIcon />, applets, "new", onApplets)}
  </nav>;
}
