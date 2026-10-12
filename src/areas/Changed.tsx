import { changedLine, type Mark } from "./steerCore";

/** "changed just now · was Tue 10-13": the caption under an item a steer moved (the sap rule is the row's `.changed`). */
export function Changed({ marks, nowMs }: { marks: readonly Mark[] | undefined; nowMs: number }) {
  if (!marks?.length) return null;
  return <span className="chg" data-field={marks[0].field}>{marks.map((m, i) => <span key={i} className="chg-line">{changedLine(m, nowMs)}</span>)}</span>;
}
