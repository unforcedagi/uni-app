// 0.2.2: the room an ask acts in (askRoom), and the words a "Say …" step puts in it (stepAudience). Run: node --experimental-strip-types scripts/askRoom.test.ts
import assert from "node:assert/strict";
import { askRoom, type RoomRef } from "../src/areas/talkCore.ts";
import { stepAudience } from "../src/areas/simpleCore.ts";

const rooms: RoomRef[] = [{ id: "ch-1", name: "Garden" }, { id: "ch-2", name: "kiln-studio" }, { id: "ch-3", name: "atlas/build" }];
const nodeRoom = (n: string): RoomRef | null => (n === "Areas/Garden" ? rooms[0] : null);
let failed = 0;
const check = (name: string, f: () => void) => { try { f(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, (e as Error).message); } };

check("an ask's own room wins over its node's", () => assert.equal(askRoom({ room: "kiln-studio", node: "Areas/Garden" }, rooms, nodeRoom)?.id, "ch-2"));
check("by name, with or without #, any case", () => assert.equal(askRoom({ room: "#Kiln-Studio", node: "Uni" }, rooms, nodeRoom)?.id, "ch-2"));
check("by channel id", () => assert.equal(askRoom({ room: "ch-3", node: "Uni" }, rooms, nodeRoom)?.id, "ch-3"));
check("a room that doesn't exist falls back to the node's", () => assert.equal(askRoom({ room: "mail", node: "Areas/Garden" }, rooms, nodeRoom)?.id, "ch-1"));
check("no room anywhere is none (never a guess)", () => assert.equal(askRoom({ room: null, node: "Uni" }, rooms, nodeRoom), null));
check("a slashed name matches only itself", () => assert.equal(askRoom({ room: "atlasbuild", node: "Uni" }, rooms, nodeRoom), null));

check('"Say "x" in #room" says x', () => assert.deepEqual(stepAudience('Say "approve cards" in #garden', "garden"), { kind: "room", text: "approve cards" }));
check("curly quotes too", () => assert.deepEqual(stepAudience("Say “ship it” when the build is green", "garden"), { kind: "room", text: "ship it" }));
check("an unquoted word keeps its clause", () => assert.deepEqual(stepAudience("Say go to deploy the site", "garden"), { kind: "room", text: "Go to deploy the site" }));

if (failed) process.exit(1);
