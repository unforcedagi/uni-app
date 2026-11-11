// T-335 OTA: which screens are running (over the air or built in), beside the app version.
import { useEffect, useState } from "react";
import { otaStatus, webLabel } from "./ota";

export default function WebVersion({ className }: { className?: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => { let on = true; void otaStatus().then((s) => on && setLabel(webLabel(s))); return () => { on = false; }; }, []);
  return label ? <span className={className ?? "update-version"} data-testid="web-version">{label}</span> : null;
}
