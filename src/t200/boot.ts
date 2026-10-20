import { NOTE_MODE } from "./mode";
import { installFixture } from "./fixture";

// T-200: the previews and their browser tests run on invented data. Nothing here is in a normal build (the constant folds away).
if (import.meta.env.VITE_T200_FIXTURE === "1") installFixture(NOTE_MODE);
