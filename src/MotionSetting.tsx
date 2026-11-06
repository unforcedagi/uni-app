// T-335: Settings → Calm screen. One tap on the Daylight, where each frame of motion is a slow redraw (src/motion.ts).
import { setCalmChosen, useCalmBySystem, useCalmChosen } from "./motion";

export default function MotionSetting() {
  const chosen = useCalmChosen();
  const system = useCalmBySystem();
  return <label className="settings-check">
    <input type="checkbox" checked={chosen} onChange={(e) => setCalmChosen(e.target.checked)} />
    <span>Calm screen<small>{system && !chosen ? "This device already asks for less motion. Tick this to keep it calm whatever the device says." : "Nothing moves or glides, and pages turn to black ink on white; for a slow screen like the Daylight."}</small></span>
  </label>;
}
