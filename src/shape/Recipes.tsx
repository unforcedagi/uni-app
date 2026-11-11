// T-335 Recipes: the drawer's placeholder slot. It says plainly that it isn't built; a sealed applet note with the id
// "recipes" takes this slot when it arrives (src/interface/applets.ts, joinApplets).
import "./applets.css";

export function Recipes() {
  return <div className="sh-ap-calm">
    <p className="sh-ap-calm-head">Recipes isn't built yet.</p>
    <p>It will be a book of recipes, kept as notes in your vault.</p>
  </div>;
}
