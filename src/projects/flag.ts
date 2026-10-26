// T-301: the area-projects prototype is on in its own web build only (VITE_T301_PROTO=1); every other build is unchanged.
export const PROJECTS_PROTO = import.meta.env.VITE_T301_PROTO === "1";
