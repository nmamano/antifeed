// Per-project consults (Nil, 2026-10-28): a new isomux card's predict goes
// to Isomux Consult and a new Wall Game card's to Wall Game Consult, through
// the real dispatcher, against a fake office. Office-app policies (not the
// walkthrough's stubs). Run: bun tools/consult-route-check.ts
import { BoardSource } from "../src/board";
import { Dispatcher } from "../src/dispatcher";
import { folderHash } from "../src/policies";
import isomux from "../projects/isomux/policies";
import wallgame, { WALLGAME_PM_ID, WALLGAME_ROOM } from "../projects/wallgame/policies";
import { cleanup, engine, fakePredict, tempDir } from "../test/helpers";
import { FakeOffice } from "../test/fake-office";

const ISO = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const WG = new URL("../projects/wallgame/policies.ts", import.meta.url).pathname;
const x = engine(tempDir(), { projects: [{ def: isomux, path: ISO, hash: folderHash(ISO) }, { def: wallgame, path: WG, hash: folderHash(WG) }], predict: fakePredict().rt });
const office = new FakeOffice();
office.roster = [
  { id: "agent-curator", name: "Isomux Curator", roomId: "e6818e47", roomName: "Isomux" },
  { id: "agent-isomux-consult", name: "Isomux Consult", roomId: "e6818e47", roomName: "Isomux" },
  { id: "agent-wallgame-consult", name: "Wall Game Consult", roomId: WALLGAME_ROOM, roomName: "Wall Game" },
  { id: WALLGAME_PM_ID, name: "Wall Game PM", roomId: WALLGAME_ROOM, roomName: "Wall Game" },
];
const d = new Dispatcher(x.e, office, "http://127.0.0.1:21042", () => x.clock.t);
const read = () => Promise.all([new BoardSource(x.e, office, "isomux", "board", "e6818e47").poll(), new BoardSource(x.e, office, "wallgame", "board", WALLGAME_ROOM).poll()]);
await read(); // the first read of each board: nothing on them yet
office.put({ id: "iso-new", roomId: "e6818e47", title: "A new isomux task", description: "" });
office.put({ id: "wg-new", roomId: WALLGAME_ROOM, title: "A new Wall Game task", description: "" });
await read();
await x.e.settle();
// The Curator writes the isomux packet; the Wall Game packet is code.
const prep = [...x.e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === "iso-new")!;
x.e.startCommand(prep.id);
x.e.postPacket({ command: prep.id, packet: { question: "Triage: a new isomux task", blocks: [{ type: "markdown", text: "x" }] }, meta: { raw: "https://office.example.com" } });
await x.e.settle();
office.sent.length = 0;
await d.tick();
const name = (id: string) => office.roster.find((a) => a.id === id)?.name ?? id;
for (const k of [...x.e.commands.values()].filter((k) => k.type === "predict")) {
  const c = x.e.cards.get(k.card!)!;
  const m = office.sent.find((s) => s.text.includes(k.id));
  console.log(`${c.project} card ${c.subject}: predict ${k.id} ${k.state} -> ${m ? `${name(m.to)} (${m.to})` : "not sent"}`);
}
for (const s of office.sent) console.log(`  sent to ${name(s.to)}: ${s.text.split("\n")[0]}`);
cleanup();
process.exit(0);
