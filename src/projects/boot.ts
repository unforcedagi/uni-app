// T-301: imported first by main.tsx, so the prototype's stand-in backend is in place before any module can call the native side.
import { PROJECTS_PROTO } from "./flag";
import { installDemoBackend } from "./demoBackend";

if (PROJECTS_PROTO && typeof window !== "undefined") installDemoBackend();
