import "./t200/boot";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateNotice from "./UpdateNotice";
import { migrateHomeLayout } from "./areas/homeLayout";
import { NOTE_MODE } from "./t200/mode";
import { noteWindowParams } from "./t200/noteWindow";
import NoteWindow from "./t200/NoteWindow";

/** A render error in remote content must not blank the whole app. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("render error", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pairing"><div className="pairing-card">
        <span className="eyebrow">Unforced</span>
        <h1>Something slipped</h1>
        <p className="pairing-note">The screen hit an error and stopped drawing. Your journal queue and messages are safe on the device.</p>
        <p className="pairing-note">{this.state.error.message}</p>
        <button className="send pairing-primary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div></div>
    );
  }
}

// T-124 r12: the room tree is the only layout; a saved Map, Octopus or Classic choice is dropped once, here.
migrateHomeLayout();

// T-200 C: a note window is the same app showing one note (only when the prototype flag is on).
const noteWindow = NOTE_MODE === "window" ? noteWindowParams() : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {noteWindow ? <NoteWindow target={noteWindow.target} room={noteWindow.room} /> : <><App />
      <UpdateNotice /></>}
    </ErrorBoundary>
  </React.StrictMode>,
);
