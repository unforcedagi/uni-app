// T-335 as Aaron: "Bee Garden" and "#bee-garden" say the same thing: the second line under a room's name is only there when it adds something.
const words = (s: string) => s.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const sameWords = (name: string, slug: string) => { const a = words(name); return !!a && a === words(slug); };
