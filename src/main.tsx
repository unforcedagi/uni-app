import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateNotice from "./UpdateNotice";
import { migrateHomeLayout } from "./areas/homeLayout";
import { otaBoot, otaRendered } from "./ota";

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

/** T-305: mounted beside App, so it commits only when the first render did not throw. */
function OtaReady() {
  React.useEffect(() => otaRendered(), []);
  return null;
}

void otaBoot().then((ok) => {
  if (!ok) return;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
        <UpdateNotice />
        <OtaReady />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
