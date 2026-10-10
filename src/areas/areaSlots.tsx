import type { ComponentType } from "react";
import { slotFor, type SlotProps } from "./nodeMap";

/**
 * The area slot (T-83): one region of the node view where an area may draw its own content. Register a component by the
 * node's path (`"Areas/Sadhana": SadhanaView`); every path without one shows the stub. Empty on purpose until areas get their own view.
 */
export const areaSlots: Record<string, ComponentType<SlotProps>> = {};

export function AreaSlot({ node, registry = areaSlots }: SlotProps & { registry?: Readonly<Record<string, ComponentType<SlotProps>>> }) {
  const Own = slotFor(registry, node.path);
  return <section className="node-slot" aria-label={`${node.name}'s own view`} data-slot={Own ? "own" : "stub"}>
    {Own ? <Own node={node} /> : <p className="node-slot-stub">This space is for {node.name}'s own view.</p>}
  </section>;
}
