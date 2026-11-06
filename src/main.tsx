import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateChecks from "./UpdateNotice";
import { migrateHomeLayout } from "./areas/homeLayout";
import { startMotion } from "./motion";
import { startTide } from "./glow/tide";
// T-335 glow-up: the look's tokens and fonts, after every other stylesheet the entry pulls in
import "./glow/glow.css";
// T-335 chat feel: the room's turn with Uni, on the glow-up tokens
import "./chatFeel.css";
// T-335 as Aaron: the finishing pass over every screen, last so it reads as the final word
import "./glow/finish.css";

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
// T-335: calm or not, on the root before the first paint
startMotion();
// T-335 glow-up: the accent's hue for the time of day
startTide();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <UpdateChecks />
    </ErrorBoundary>
  </React.StrictMode>,
);
