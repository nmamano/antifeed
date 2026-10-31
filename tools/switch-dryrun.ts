// The isomux triage switch, a dry run (Antifeed PM's checks, 2026-10-28): the
// live log in a copy, with the policies of TRIAGE on or off, the loop app's
// precedent import, and one read of each board through a read-only office
// (an agent token, GET routes only). Nothing is sent: no dispatcher, and the
// office's writes throw.
//   bun tools/switch-dryrun.ts <copy of the data dir's live/> on|off
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BoardSource } from "../src/board";
import { LOOP_SEED } from "../src/config";
import { Engine } from "../src/engine";
import { nullOffice, type Office } from "../src/office";
import { loadProjects } from "../src/policies";
import { fetchLoopItems, loopLines } from "../src/seed-loop";

const [dir, mode] = process.argv.slice(2);
// It writes events into the dir: never into an app's own data (the live log).
const appData = join(homedir(), ".isomux", "apps", "data");
const real = dir && existsSync(dir) ? realpathSync(dir) : resolve(dir ?? "");
if (!dir || real === appData || real.startsWith(appData + "/")) {
  console.error(`refused: give a copy of the data dir, not ${dir ?? "nothing"} (an app's own data is under ${appData})`);
  process.exit(2);
}
const here = (p: string) => new URL(p, import.meta.url).pathname;
const paths = [here("../projects/inbox/policies.ts"), ...(mode === "on" ? [here("../projects/isomux/policies.ts")] : []), here("../projects/wallgame/policies.ts")];
const projects = await loadProjects(paths);
const e = new Engine({ dir, projects: projects.loaded, runtime: { agent: () => ({ id: "agent:none", decide: () => new Promise(() => {}) }) } });
console.log(`projects ${projects.loaded.map((p) => p.def.project).join(", ")}; refused ${projects.refused.length}; replayDiffs ${e.replayDiffs.length}`);
for (const d of e.replayDiffs) console.log("  diff", JSON.stringify(d));
if (projects.loaded.some((p) => p.def.project === LOOP_SEED.project)) {
  const lines = loopLines(await fetchLoopItems(), LOOP_SEED.policy, LOOP_SEED.project);
  const r = e.importPrecedent(LOOP_SEED.policy, LOOP_SEED.source, lines);
  console.log(`precedent: ${lines.length} loop app calls, duplicate ${r.duplicate}`);
  console.log(`precedent again: duplicate ${e.importPrecedent(LOOP_SEED.policy, LOOP_SEED.source, lines).duplicate}`);
}
const H = { Authorization: `Bearer ${process.env.ISOMUX_AGENT_TOKEN}` };
const get = async (path: string) => {
  const res = await fetch("http://localhost:4000" + path, { headers: H });
  return res.ok ? res.json() : null;
};
const office: Office = { ...nullOffice, tasks: async (room) => (await get(`/api/tasks?roomId=${room}`)) ?? [], task: async (id) => get(`/api/tasks/${id}`) };
const before = new Set(e.cards.keys());
const kBefore = new Set(e.commands.keys());
for (const p of projects.loaded)
  for (const s of (p.def.sources ?? []).filter((x) => x.kind === "isomux-board")) {
    const r = await new BoardSource(e, office, p.def.project, s.id, String(s.roomId)).poll();
    console.log(`board ${p.def.project}: seen ${r.seen}, filed ${r.filed}, changed ${r.changed}, closed ${r.closed}, errors ${r.errors.length}`);
  }
const fresh = [...e.cards.values()].filter((c) => !before.has(c.id));
console.log(`new cards: ${fresh.length}`);
for (const c of fresh) console.log(`  ${c.project}/${c.policy} ${c.subject} ${c.state}`);
// An isomux card opens with a prepare command to the Curator; its packet comes later.
const asked = [...e.commands.values()].filter((k) => !kBefore.has(k.id) && k.type !== "predict");
console.log(`new commands: ${asked.length}`);
for (const k of asked) console.log(`  ${k.project}/${k.policy} ${k.type} ${k.subject} ${k.state}`);
const seen = e.log.all().filter((x) => x.project === "isomux" && x.type.startsWith("board.task."));
console.log(`isomux board events: ${seen.length} (${[...new Set(seen.map((x) => x.type))].join(", ")})`);
process.exit(0);
