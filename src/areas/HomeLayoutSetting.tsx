import { HOME_LAYOUTS, useHomeLayout, writeHomeLayout } from "./homeLayout";

/** Settings → Home layout: Tree (new), Octopus (0.1.39) or Classic. Stored on this device. */
export default function HomeLayoutSetting() {
  const current = useHomeLayout();
  return <fieldset className="home-layout-setting">
    <legend>Home layout</legend>
    {HOME_LAYOUTS.map((l) => <label key={l.id} className={current === l.id ? "on" : ""}>
      <input type="radio" name="home-layout" value={l.id} checked={current === l.id} onChange={() => writeHomeLayout(l.id)} />
      <span><b>{l.label}</b><small>{l.hint}</small></span>
    </label>)}
  </fieldset>;
}
