// Re-prepare every open card of a policy (Antifeed PM, 2026-10-29: the
// triage packet shape changed). The engine issues the prepares
// REPREPARE_AT_ONCE at a time; the author's new packet gets a new Premove by
// itself.
//   bun tools/reprepare.ts dry <copy of the data dir's live/> <policy> <revise>
//     the live log in a copy: asks every card, plays the author (each prepare
//     posts the card's own packet again), checks the pace and that a replay
//     gives no difference. Nothing is sent: no dispatcher, no office.
//   bun tools/reprepare.ts live <base url> <policy> <revise>
//     POST /api/policies/<policy>/reprepare on the running app.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Blobs } from "../src/blobs";
import { POLICY_PATHS } from "../src/config";
import { Engine, REPREPARE_AT_ONCE, type EngineOptions } from "../src/engine";
import { loadProjects } from "../src/policies";

const [mode, where, policy, revise] = process.argv.slice(2);
if (!["dry", "live"].includes(mode) || !where || !policy || !revise) {
  console.error("usage: bun tools/reprepare.ts dry|live <copy dir|base url> <policy> <revise>");
  process.exit(2);
}

if (mode === "live") {
  const r = await fetch(`${where}/api/policies/${policy}/reprepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revise }) });
  console.log(r.status, await r.text());
  process.exit(r.ok ? 0 : 1);
}

// It writes events into the dir: never into an app's own data (the live log).
const appData = join(homedir(), ".isomux", "apps", "data");
const real = existsSync(where) ? realpathSync(where) : resolve(where);
if (real === appData || real.startsWith(appData + "/")) {
  console.error(`refused: give a copy of the data dir, not ${where} (an app's own data is under ${appData})`);
  process.exit(2);
}
const projects = await loadProjects(POLICY_PATHS);
const blobs = new Blobs(where);
const predict: EngineOptions["predict"] = {
  input: (p, _criteria, card) => ({ text: `dry run: ${p} ${card.id} v${card.version}`, criteriaHash: "dryrun", precedent: [] }),
  putBlob: (t) => blobs.putText(t),
  getBlob: (n) => blobs.getText(n),
  agentModel: () => "dry-run",
  standin: async () => {
    throw new Error("no stand-in in a dry run");
  },
  startMs: 120_000,
  answerMs: 600_000,
};
const open = () => new Engine({ dir: where, projects: projects.loaded, predict, runtime: { agent: () => ({ id: "agent:none", decide: () => new Promise(() => {}) }) } });
const e = open();
console.log(`projects ${projects.loaded.map((p) => p.def.project).join(", ")}; refused ${projects.refused.length}; replayDiffs ${e.replayDiffs.length}`);
const { cards: asked, skipped } = e.reprepare(policy, revise, "code:reprepare-dryrun");
console.log(`cards asked: ${asked.length}; skipped (no earlier prepare): ${skipped.length}`);
const mine = () => [...e.commands.values()].filter((k) => asked.includes(k.card ?? "") && (k.params as { revise?: string })?.revise === revise);
const out = () => mine().filter((k) => !["done", "failed", "cancelled"].includes(k.state));
let most = 0;
let rounds = 0;
while (out().length) {
  most = Math.max(most, out().length);
  rounds++;
  for (const k of out()) {
    const c = e.cards.get(k.card!)!;
    e.startCommand(k.id);
    e.postPacket({ command: k.id, packet: c.packet!, meta: c.meta });
  }
  e.reprepareStep();
}
const prepares = mine();
const byCard = new Map<string, number>();
for (const k of prepares) byCard.set(k.card!, (byCard.get(k.card!) ?? 0) + 1);
console.log(`prepares: ${prepares.length} in ${rounds} rounds, at most ${most} out at once (limit ${REPREPARE_AT_ONCE}); cards asked twice: ${[...byCard.values()].filter((n) => n > 1).length}`);
console.log(`new packet versions: ${asked.filter((id) => e.cards.get(id)!.state === "predicting" || e.cards.get(id)!.state === "open").length}; left: ${e.reprepareLeft().length}`);
console.log(`a second request asks: ${e.reprepare(policy, revise, "code:reprepare-dryrun").cards.length} (each card's packet is new: its new version)`);
e.close();
const again = open();
console.log(`replay after the re-prepare: replayDiffs ${again.replayDiffs.length}; a step issues ${again.reprepareStep()}`);
again.close();
process.exit(0);
