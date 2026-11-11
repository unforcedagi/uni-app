// T-335 the shape: the places. A bottom bar on a phone, the same nav as a left rail on a wide screen (shape.css). T-335 fixes (11-11): it
// shows everywhere (in a room, under a run's story or an ask's sheet, over Settings), stepping aside only while the keyboard is up; and
// Settings is its fourth place, so it is one tap away from anywhere (Aaron: "we appear to have lost the settings menu so I can't see usage").
import type { ReactNode } from "react";
import { JournalIcon, MoreIcon, SettingsIcon, UniIcon } from "../Icons";
import "./shape.css";

export type Place = "rooms" | "journal" | "applets" | "settings";
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
  /** Settings, over the place you are in (a second tap closes it). */
  onSettings(): void;
  /** The applets drawer is open over the place: Applets is the current one while it is. */
  drawerOpen?: boolean;
  /** Settings is open over the place: Settings is the current one while it is. */
  settingsOpen?: boolean;
};

const short = (n: number) => (n > 99 ? "99+" : String(n));

export function Bar({ place, wants, applets, onRooms, onJournal, onApplets, onSettings, drawerOpen = false, settingsOpen = false }: BarProps) {
  const here = settingsOpen ? "settings" : drawerOpen ? "applets" : place;
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
    {item("settings", "Settings", <SettingsIcon />, 0, "", onSettings)}
  </nav>;
}
