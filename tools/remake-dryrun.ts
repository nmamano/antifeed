// The remake of Premoves by another project's Predictor, a dry run (Antifeed
// PM, 2026-10-29): the live log in a copy, the live policies, one
// remakeForeign() as the clock would run it. It lists the predicts it issues
// and checks that a replay of the copy gives no difference. Nothing is sent:
// no dispatcher, no office.
//   bun tools/remake-dryrun.ts <copy of the data dir's live/>
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Blobs } from "../src/blobs";
import { POLICY_PATHS } from "../src/config";
import { Engine, type EngineOptions } from "../src/engine";
import { loadProjects } from "../src/policies";

const [dir] = process.argv.slice(2);
// It writes events into the dir: never into an app's own data (the live log).
const appData = join(homedir(), ".isomux", "apps", "data");
const real = dir && existsSync(dir) ? realpathSync(dir) : resolve(dir ?? "");
if (!dir || real === appData || real.startsWith(appData + "/")) {
  console.error(`refused: give a copy of the data dir, not ${dir ?? "nothing"} (an app's own data is under ${appData})`);
  process.exit(2);
}
const projects = await loadProjects(POLICY_PATHS);
const blobs = new Blobs(dir);
const predict: EngineOptions["predict"] = {
  input: (policy, _criteria, card) => ({ text: `dry run: ${policy} ${card.id} v${card.version}`, criteriaHash: "dryrun", precedent: [] }),
  putBlob: (t) => blobs.putText(t),
  getBlob: (n) => blobs.getText(n),
  agentModel: () => "dry-run",
  standin: async () => {
    throw new Error("no stand-in in a dry run");
  },
  startMs: 120_000,
  answerMs: 600_000,
};
const open = () => new Engine({ dir, projects: projects.loaded, predict, runtime: { agent: () => ({ id: "agent:none", decide: () => new Promise(() => {}) }) } });
const e = open();
console.log(`projects ${projects.loaded.map((p) => p.def.project).join(", ")}; refused ${projects.refused.length}; replayDiffs ${e.replayDiffs.length}`);
const kBefore = new Set(e.commands.keys());
const n = e.remakeForeign();
const made = [...e.commands.values()].filter((k) => !kBefore.has(k.id));
console.log(`remake predicts issued: ${n}`);
const by: Record<string, number> = {};
for (const k of made) {
  const c = e.cards.get(k.card!)!;
  const from = String(c.prediction?.by).replace(/@.*/, "");
  const to = e.consultActor(c.project);
  const key = `${c.project}: ${from} -> ${to?.kind === "agent" ? to.agentName : to?.id}${c.shown.includes(c.version) ? " (seen)" : ""}`;
  by[key] = (by[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v}`);
console.log(`other new commands: ${made.filter((k) => !k.remake).length}`);
console.log(`a second run issues: ${e.remakeForeign()}`);
e.close();
const again = open();
console.log(`replay after the remake: replayDiffs ${again.replayDiffs.length}`);
again.close();
process.exit(0);
