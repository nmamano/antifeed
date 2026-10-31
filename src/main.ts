// The app process: one engine, its timers, and the HTTP server. Run as an
// isomux app: PORT, ISOMUX_APP_DATA_DIR, ISOMUX_APP_TOKEN, ISOMUX_APP_HOST.

import { makeApi } from "./api";
import { Blobs } from "./blobs";
import { BoardSource } from "./board";
import { fetchLoopItems, loopLines } from "./seed-loop";
import { FakeInbox } from "./fake-inbox";
import { ASKS_OFF, InboxSource } from "./inbox";
import { LoopSignoffSource } from "./loop-signoff";
import { GameVideoSource } from "./game-video";
import { setVideoUrl, VIDEO_MEMBER, videoUrl } from "../projects/wallgame/video";
import { AGENTS_MS, BOARD_MS, INBOX, INBOX_MS, MOVED_TO_INBOX, LOOP_MS, LOOP_URL, CHAT_URL, CLOCK_MS, DEMO, DEMO_DIR, HELD_MS, LOOP_SEED, DISPATCH_MS, NIL_MEMBER_ID, NIL_NAME, POLICY_PATHS, PREDICT_ANSWER_MS, PREDICT_START_MS, PREDICT_TIMEOUT_MS, PREDICTOR_DAILY_RUNS, RUN_MAX_USD, STANDIN_MODEL, WALKTHROUGH } from "./config";
import { dirname } from "node:path";
import { runClaude } from "./claude";
import { consultInputFactory, predictorFactory, standinFactory } from "./predictor";
import { buildView, cardContext, criteriaText, type SourceAlert } from "./view";
import type { Agent } from "./office";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Dispatcher } from "./dispatcher";
import { ChatSender } from "./chat";
import { INPUT_TARGETS, InputSender } from "./input";
import { Engine } from "./engine";
import { httpOffice, NIL_TOKEN, nullOffice, OFFICE, SEND_MS } from "./office";
import { loadProjects } from "./policies";

const port = Number(process.env.PORT);
const appDir = process.env.ISOMUX_APP_DATA_DIR;
const token = process.env.ISOMUX_APP_TOKEN;
if (!Number.isInteger(port) || !appDir) throw new Error("PORT and ISOMUX_APP_DATA_DIR are required");
const dataDir = join(appDir, DEMO ? DEMO_DIR : "live");
const base = `http://127.0.0.1:${port}`;

const projects = await loadProjects(POLICY_PATHS);
for (const r of projects.refused) console.error(`policies refused: ${r.path}\n  ${r.problems.join("\n  ")}`);

// A policy's folder (its criteria files) and answer fields, by policy id.
const folderOfMaybe = (policy: string) => {
  const p = projects.loaded.find((x) => x.def.policies.some((y) => y.id === policy));
  return p ? dirname(p.path) : undefined;
};
const folderOf = (policy: string) => folderOfMaybe(policy)!;
const answerOf = (policy: string) => projects.loaded.flatMap((p) => p.def.policies).find((x) => x.id === policy)?.answer ?? {};
// The claude -p runs start in an empty folder, so no project settings load.
const runCwd = join(dataDir, "claude-cwd");
let engine: Engine;
// Predictor runs today (Pacific day), counted from the log.
const runsToday = () => {
  const day = (t: Date) => t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const today = day(new Date());
  return engine.log.all().filter((e) => e.type === "card.predicted" && /agent:(predictor|standin)/.test(String(e.data?.decider ?? "")) && day(new Date(e.at)) === today).length;
};
// What the claude -p runs cost today (Pacific day), for the status view.
const spendToday = () => {
  const day = (t: Date) => t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const today = day(new Date());
  const s = { standinRuns: 0, standinUsd: 0 };
  for (const e of engine.log.all()) {
    if (day(new Date(e.at)) !== today) continue;
    if (e.type === "card.predicted" && /agent:(predictor|standin)/.test(String(e.data?.decider ?? ""))) {
      s.standinRuns++;
      s.standinUsd += e.data?.prediction?.usd ?? 0;
    }
  }
  return s;
};
const blobs = new Blobs(dataDir);
// The office's agents by name, read every AGENTS_MS (the consult agent's model and live state).
let agents = new Map<string, Agent>();
let agentsVersion = "";
let dispatcher: Dispatcher | undefined;
const allowRun = () => runsToday() < PREDICTOR_DAILY_RUNS;
const claudeStandin = standinFactory({ run: runClaude, model: STANDIN_MODEL, answerOf, maxUsd: RUN_MAX_USD, cwd: runCwd, allowRun });
// The walkthrough copy has no claude -p spend: a fake stand-in from the seed (DESIGN.md 13.4).
const walkthroughStandin = async (policy: string, text: string) => {
  const { standinFor } = await import("../projects/demo/seed");
  return standinFor(policy, text);
};
engine = new Engine({
  dir: dataDir,
  projects: projects.loaded,
  human: NIL_NAME,
  inputTargets: INPUT_TARGETS.map((t) => t.id),
  predictTimeoutMs: PREDICT_TIMEOUT_MS,
  runtime: { agent: predictorFactory({ run: runClaude, folderOf, answerOf, cwd: runCwd, maxUsd: RUN_MAX_USD, allowRun }) },
  predict: {
    input: consultInputFactory({ folderOf, answerOf, base: `http://127.0.0.1:${port}` }),
    putBlob: (t) => blobs.putText(t),
    getBlob: (n) => blobs.getText(n),
    agentModel: (name) => agents.get(name)?.model,
    standin: WALKTHROUGH ? walkthroughStandin : claudeStandin,
    startMs: PREDICT_START_MS,
    answerMs: PREDICT_ANSWER_MS,
  },
  onIssued: () => dispatcher?.kick(),
});
if (engine.replayDiffs.length) console.error(`replay differences after a code change: ${engine.replayDiffs.length} (GET /api/status)`);
// Nil, 2026-10-31 (DESIGN.md 22): the waiting cards of the kinds that moved to the Isomux Inbox.
if (!DEMO) {
  const moved = engine.withdrawOff(MOVED_TO_INBOX.policies, MOVED_TO_INBOX.reason);
  if (moved.length) console.log(`withdrew ${moved.length} card(s): ${MOVED_TO_INBOX.reason}`);
}

// No token: a copy of the data dir away from the office. It reads and sends nothing.
// The walkthrough copy reads a fake office that this process serves under
// /fake-office (DESIGN.md 14.5), through the real office client.
const FAKE_PREFIX = "/fake-office";
const fake = WALKTHROUGH ? new FakeInbox() : null;
if (fake) (await import("../projects/inbox/walkthrough")).seedInbox(fake);
if (fake && projects.loaded.some((p) => p.def.project === "wallgame")) (await import("../projects/wallgame/walkthrough")).seedBoard(fake);
// Round q1, I: the walkthrough's office has each input target's PM, so an input is told.
if (fake) for (const t of INPUT_TARGETS) if (!fake.roster.some((a) => a.id === t.pm.id)) fake.roster.push({ id: t.pm.id, name: t.pm.name, roomId: t.roomId, roomName: t.name });
// Part J's end-to-end (a Loop app copy whose office is this fake one): Isomux Main gets the revert, the Scout its commands.
if (fake && process.env.ANTIFEED_LOOP_URL)
  for (const [id, name] of [["agent-main-e2e", "Isomux Main"], ["agent-scout-e2e", "Isomux Sign-off Scout"]]) if (!fake.roster.some((a) => a.name === name)) fake.roster.push({ id, name, roomId: "e6818e47", roomName: "Isomux" });
// The walkthrough's fake office can leave a message unanswered: 5 s, not SEND_MS, so its checks are quick.
// Part N: Nil's API token for his asks (the walkthrough's fake office takes any).
const nilToken = process.env[NIL_TOKEN] || null;
const office = fake ? httpOffice("walkthrough", base + FAKE_PREFIX, 5_000, "walkthrough-nil") : token ? httpOffice(token, OFFICE, SEND_MS, nilToken) : nullOffice;
dispatcher = new Dispatcher(engine, office, base);
// Round q1, H1: Nil's chat with a card's consult.
const chat = new ChatSender(engine, office, base, () => agents);
const cut = engine.chatRestarted();
if (cut) console.error(`chat: ${cut} message(s) were on their way when the app stopped; they show "may not have gone out"`);
// Round q1, I: Nil's input that becomes a task.
const input = new InputSender(engine, office, (n) => blobs.path(n));
const cutInputs = engine.inputRestarted();
if (cutInputs) console.error(`input: ${cutInputs} input(s) were on their way when the app stopped`);
const sources = projects.loaded.flatMap((p) =>
  (p.def.sources ?? []).filter((s) => s.kind === "isomux-board").map((s) => new BoardSource(engine, office, p.def.project, s.id, String(s.roomId))),
);
const inboxes = projects.loaded.flatMap((p) => (p.def.sources ?? []).filter((s) => s.kind === "isomux-inbox").map((s) => new InboxSource(engine, office, blobs, p.def.project, s.id)));
// Part J: the Loop app's Sign-off list (read only; ANTIFEED_LOOP_URL for a copy).
const loops = projects.loaded.flatMap((p) => (p.def.sources ?? []).filter((s) => s.kind === "loop-signoff").map((s) => new LoopSignoffSource(engine, blobs, p.def.project, s.id, LOOP_URL)));
// Wall Game video review: the live app only for the live Antifeed; a copy (no office token, or the walkthrough) reads and presses nothing there.
if (!token || fake) setVideoUrl("http://127.0.0.1:9");
const videos = projects.loaded.flatMap((p) => (p.def.sources ?? []).filter((s) => s.kind === "game-video").map((s) => new GameVideoSource(engine, blobs, p.def.project, s.id, videoUrl(), VIDEO_MEMBER)));
const last: Record<string, unknown> = {};

// Demo mode: the seed cards, once (a repeated key is dropped).
if (DEMO) {
  const { seed } = await import("../projects/demo/seed");
  const assets = new URL("../projects/demo/assets/", import.meta.url).pathname;
  const fix = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(fix)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
    : typeof v === "string" && v.startsWith("asset:") ? (blobs.put("image/png", readFileSync(join(assets, v.slice(6)))) as { name: string }).name
    : v;
  for (const it of seed) engine.sourceEvent({ project: "demo", source: "seed", type: "demo.item", subject: it.id, data: fix(it), key: it.id });
}

// Live mode: the loop app's triage calls, once (a second import is a duplicate).
// Before the timers, so the first board read and predictor run have the precedent.
if (!DEMO && engine.isOn(LOOP_SEED.policy)) {
  try {
    const lines = loopLines(await fetchLoopItems(), LOOP_SEED.policy, LOOP_SEED.project);
    const r = engine.importPrecedent(LOOP_SEED.policy, LOOP_SEED.source, lines);
    if (!r.duplicate) console.log(`imported ${lines.length} triage calls from the loop app as precedent`);
  } catch (err) {
    // The next start tries again.
    console.error(`loop app seed: ${(err as Error).message}`);
  }
}

const every = (ms: number, name: string, f: () => Promise<unknown> | unknown) => {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      last[name] = { at: new Date().toISOString(), result: await f() };
    } catch (err) {
      last[name] = { at: new Date().toISOString(), error: (err as Error).message };
      console.error(`${name}: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  void run();
  return setInterval(run, ms);
};
every(CLOCK_MS, "clock", () => ({ wakes: engine.fireWakes(), standins: engine.checkPredicts() }));
// A held Done is sent within a second of its Undo time.
every(HELD_MS, "actions", () => engine.finishHeld());
every(AGENTS_MS, "agents", async () => {
  const list = await office.agents();
  agents = new Map(list.map((a) => [a.name, a]));
  agentsVersion = list.map((a) => `${a.name}:${a.model ?? ""}:${a.inFlightTurn ? 1 : 0}`).sort().join("|");
  return list.length;
});
every(DISPATCH_MS, "dispatch", () => dispatcher.tick());

// Queue round 1 (S1): the sources that are broken now: the last read failed
// (a board or the Inbox), or the Inbox's asks did not load for a reason other
// than Nil's access (that one is a state, shown on the Sources tab only).
const sourceAlerts = (): SourceAlert[] => {
  const out: SourceAlert[] = [];
  for (const [k, v] of Object.entries(last) as [string, { error?: string; result?: { asksOff?: string } }][]) {
    if (!k.startsWith("board:") && !k.startsWith("inbox:") && !k.startsWith("loop:") && !k.startsWith("video:")) continue;
    const error = v.error ?? (v.result?.asksOff && v.result.asksOff !== ASKS_OFF ? v.result.asksOff : null);
    if (error) out.push({ key: k, error });
  }
  return out;
};
const viewOpts = { engine, agents: () => agents, folderOf: folderOfMaybe, chatUrl: CHAT_URL, sourceAlerts };
const api = makeApi({
  engine, blobs, member: NIL_MEMBER_ID, base,
  status: () => ({ timers: last, refusedProjects: projects.refused, spendToday: spendToday(), held: dispatcher.heldUntil() }),
  view: () => buildView(viewOpts),
  etag: () => `${engine.log.all().at(-1)?.seq ?? 0}-${Bun.hash(agentsVersion + JSON.stringify(sourceAlerts())).toString(36)}`,
  context: (id) => cardContext(engine, blobs, id),
  chat: (e) => chat.send(e),
  input: (id, tellOnly) => (tellOnly ? input.tell(id) : input.send(id)),
  criteria: (policy) => criteriaText(engine, folderOfMaybe, policy),
});
Bun.serve({ port, hostname: process.env.ISOMUX_APP_HOST || "127.0.0.1", fetch: fake ? async (req) => (await fake.handle(req, FAKE_PREFIX)) ?? api(req) : api, maxRequestBodySize: 210 * 2 ** 20 });
// After the server is up: the walkthrough's fake office is served by it
// (queue round 1: a board read before it failed, and the Sources tab showed
// the board as broken for its first minute).
for (const s of sources) every(BOARD_MS, `board:${s.project}/${s.source}`, () => s.poll());
for (const s of inboxes) every(INBOX_MS, `inbox:${s.project}/${s.source}`, () => s.poll());
for (const s of loops) every(LOOP_MS, `loop:${s.project}/${s.source}`, () => s.poll());
for (const s of videos) every(LOOP_MS, `video:${s.project}/${s.source}`, () => s.poll());
console.log(`antifeed on ${base}, data ${dataDir}, ${projects.loaded.length} projects, ${fake ? "the walkthrough's fake office" : token ? "office connected" : "no office token: sends nothing"}${token && !fake ? (!INBOX ? ", Nil's API token not used (asks are answered in the Isomux Inbox)" : nilToken ? ", Nil's API token set" : ", no API token of Nil's: asks off") : ""}`);

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    engine.close();
    process.exit(0);
  });
