// T-335: Settings → Calm screen. One tap on the Daylight, where each frame of motion is a slow redraw (src/motion.ts).
import { setCalmChosen, useCalmBySystem, useCalmChosen } from "./motion";

export default function MotionSetting() {
  const chosen = useCalmChosen();
  const system = useCalmBySystem();
  return <label className="settings-check">
    <input type="checkbox" checked={chosen} onChange={(e) => setCalmChosen(e.target.checked)} />
    <span>Calm screen<small>{system && !chosen ? "Already calm: this device asks for less motion." : "Nothing moves or glides; for a slow screen like the Daylight."}</small></span>
  </label>;
}
