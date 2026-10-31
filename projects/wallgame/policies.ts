// Wall Game triage (DESIGN.md section 16): the Wall Game room's board, read
// only, and Nil's calls to Wall Game PM. A Wall Game project, not the isomux
// SDLC, so it goes live on its own switch (WALLGAME in src/config.ts).
import { readFileSync } from "node:fs";
import { WALKTHROUGH } from "../../src/config";
import type { CommandRec } from "../../src/engine";
import { Blocked, definePolicies, Failed, MaybeSent, type RunContext } from "../../src/policies";
import { messageBlock, messageText, NOT_SENT_CHANGED, notSent, shown, snapshot, wallgameTriage, whyNot, type WTask } from "./triage";
import { videoParts } from "./video";
import { walkthroughPremove } from "./walkthrough";

// The video review kind, behind its switch (projects/wallgame/video.ts).
const video = videoParts();

export const WALLGAME_ROOM = "51c2d889";
// F4 (Antifeed PM, 2026-10-26): Wall Game PM by its id, not its name, so a
// name clash never sends to the wrong agent. A new id is a change here.
export const WALLGAME_PM_ID = "agent-0000000000002-aaab";
const PM = "Wall Game PM";

type Params = { taskId: string; title: string; call: Record<string, string | null>; decidedAt: string; seen: Pick<WTask, "title" | "priority" | "description"> | null };

// Why a call must not go out now (F1), from a new read of its task just
// before the send; null when it still goes.
async function stale(p: Params, ctx: RunContext): Promise<string | null> {
  const t = await ctx.office.task(p.taskId);
  if (!t || t.roomId !== WALLGAME_ROOM) return notSent("The task left the Wall Game board.");
  const now = snapshot(t as unknown as Record<string, unknown>);
  const why = whyNot(now);
  if (why) return notSent(why);
  if (p.seen && shown(p.seen) !== shown(now)) return NOT_SENT_CHANGED;
  return null;
}

const status = (err: unknown) => Number(/answered (\d{3})/.exec((err as Error).message)?.[1] ?? 0);
const NO_OWNER = "the Antifeed app has no live owner agent in the office (set one on the Apps page), so the office refused it";

// F2 on a read before the send (slice 8 walk): nothing went out yet. A 403
// is the app's missing owner agent, which holds until someone sets one.
function readFailed(err: unknown, what: string): Error {
  const raw = (err as Error).message;
  if (status(err) === 403) return new Blocked(NO_OWNER, raw);
  return new Failed(`Antifeed could not read ${what} just before the send, so nothing was sent`, raw);
}

// One office message to Wall Game PM for a burst of calls (DESIGN.md 16.5).
// Done when the office takes it, as Wall Game PM agreed (Antifeed PM, 2026-10-26).
// Each failure is in Nil's words; the raw cause goes with it as its detail.
export async function sendCalls(ks: CommandRec[], ctx: RunContext): Promise<unknown[]> {
  const them = ks.length > 1 ? "them" : "it";
  const agents = await ctx.office.agents().catch((err) => Promise.reject(readFailed(err, "the office's agent list")));
  const pm = agents.find((a) => a.id === WALLGAME_PM_ID);
  if (!pm || pm.roomId !== WALLGAME_ROOM) throw new Blocked(`${PM} is not a live agent in the Wall Game room, so nothing was sent`, `${WALLGAME_PM_ID} in room ${WALLGAME_ROOM} (WALLGAME_PM_ID in projects/wallgame/policies.ts)`);
  const results: unknown[] = [];
  const blocks: string[] = [];
  for (const k of ks) {
    const p = k.params as Params;
    const why = await stale(p, ctx).catch((err) => Promise.reject(readFailed(err, "the Wall Game board")));
    results.push(why ? { notSent: why } : { sent: true, to: pm.id });
    if (!why) blocks.push(messageBlock({ task: p.taskId, title: p.title, card: k.card ?? "", call: p.call, decidedAt: p.decidedAt }, ctx.api ?? "http://127.0.0.1:21042"));
  }
  if (!blocks.length) return results;
  try {
    await ctx.office.message(messageText(blocks), pm.id);
  } catch (err) {
    const raw = (err as Error).message;
    const n = status(err);
    // F2: a 403 (the app's token has no live owner agent) and a 404 (no such
    // agent) hold until someone fixes them.
    if (n === 403) throw new Blocked(NO_OWNER, raw);
    if (n === 404) throw new Blocked(`the office found no ${PM} to send to, so nothing was sent`, raw);
    // Another refusal: the office did not take the message.
    if (n >= 400 && n < 500) throw new Failed("the office refused the message, so nothing was sent", raw);
    // No answer, or the office broke while it took the message: it may have gone out.
    throw new MaybeSent(`the office gave no clear answer; check with ${PM} before you send ${them} again`, raw);
  }
  return results;
}

// The Wall Game project's consult agent, in the Wall Game room (Nil,
// 2026-10-28: each project has its own consult, in the project's room).
export const CONSULT = "Wall Game Consult";

export default definePolicies({
  project: "wallgame",
  name: "Wall Game",
  actors: [
    // The app itself, with its app token: it messages Wall Game PM.
    { id: "wgpm", kind: "code", handler: "wgpm" },
    { id: "nil", kind: "human", member: "Nil" },
    WALKTHROUGH ? { id: "consult", kind: "code", handler: "walkthrough-stub" } : { id: "consult", kind: "agent", agentName: CONSULT, skill: "antifeed-consult" },
    ...video.actors,
  ],
  consult: "consult",
  consultInfo: { handoffTokens: 300_000, instructions: readFileSync(new URL("../isomux/antifeed-consult/SKILL.md", import.meta.url), "utf8") },
  sources: [{ id: "board", kind: "isomux-board", roomId: WALLGAME_ROOM }, ...video.sources],
  events: {
    "board.task.seen": { from: "board", what: "a Wall Game task that was on the board at the first read" },
    "board.task.filed": { from: "board", what: "a new task on the Wall Game board" },
    "board.task.changed": { from: "board", what: "a Wall Game task that changed on the board" },
    "board.task.closed": { from: "board", what: "a Wall Game task that left the board: done, obsolete, moved to another room or deleted" },
    "wallgame.decided": { from: "wallgame-triage", what: "your triage call on a Wall Game task" },
    ...video.events,
  },
  policies: [wallgameTriage, ...video.policies],
  agents: {
    "Wall Game PM": "gets your calls in one message per burst, writes each call line and priority on the Wall Game board, and does the work in priority order",
    [CONSULT]: "predicts your call on each Wall Game packet and answers your questions about them in its own chat; read-only by instruction",
  },
  runBatch: { wgpm: sendCalls },
  run: {
    ...video.run,
    "walkthrough-stub": (k: CommandRec, ctx: RunContext) => {
      const c = k.card ? ctx.card(k.card) : undefined;
      const prediction = c?.packet ? walkthroughPremove(c.packet) : null;
      return prediction ? { prediction } : { skip: true };
    },
  },
});
