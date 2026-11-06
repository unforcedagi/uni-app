// T-335 as Aaron: every room has its own colour, the same wherever it shows (All, the home, the room's own header and composer), so a room
// is recognised before it is read. Muted earth hues from the room's id; never the only sign of anything.
export const roomTint = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 38% 42%)`; };
