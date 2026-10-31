// Constants of Nil's office (DESIGN.md section 1).

// The member whose calls the human routes take (from the office's member list, 2026-10-25).
export const NIL_MEMBER_ID = "m0000000";
export const NIL_NAME = "Nil";

// The reviewer's walkthrough copy (DESIGN.md 13.4), with DEMO: the consult
// agent is a code stub that answers at once, and the demo seed shows every
// Premove state. Never true on the office app.
export const WALKTHROUGH = process.env.ANTIFEED_WALKTHROUGH === "1";
// Demo mode: the demo project only, in the data dir's DEMO_DIR folder (the
// walkthrough copy adds the Inbox, on a fake office). Live mode: the projects
// switched on below, in live/. The office app is live since 2026-10-26; a
// walkthrough copy is always in demo mode.
const OFFICE_DEMO = false;
export const DEMO = OFFICE_DEMO || WALKTHROUGH;
// Live mode's projects. The Inbox (DESIGN.md section 14: Nil's asks and
// pages) and isomux (projects/isomux: the board, triage, sign-off; on from
// 2026-10-28) are off since Nil's decision of 2026-10-31 (DESIGN.md 22):
// Isomux decisions are asks in the Isomux Inbox, answered there ("no api
// token to be able to answer asks in the anti feed"), and the loop app wakes
// Isomux Curator for new tasks.
export const INBOX = false;
export const TRIAGE = false;
// Wall Game triage (DESIGN.md section 16): the Wall Game board's tasks, and
// Nil's calls to Wall Game PM. On from the slice 8 walk; off since Nil's
// decision of 2026-10-31 (Antifeed winds down): Wall Game PM opens its triage
// as asks in the Isomux Inbox. With it off, no project is loaded.
export const WALLGAME = false;
// The demo log's folder in the data dir. A new name starts the live demo
// again from the seed and keeps the old log, since only the app may write in
// the office's app data dir: demo2/ on 2026-10-25 (round 8), demo3/ for round 9, demo4/ for round 10, demo5/ for round 11, demo6/ for Nil's review of slice 4b.
export const DEMO_DIR = "demo6";

const here = (p: string) => new URL(p, import.meta.url).pathname;
// isomux's policies stay in this repo until Nil wants them public (Nil, 2026-10-25, Q2 A).
export const POLICY_PATHS: string[] = DEMO
  ? [here("../projects/demo/policies.ts"), ...(WALKTHROUGH ? [here("../projects/inbox/policies.ts"), here("../projects/wallgame/policies.ts")] : []), ...(WALKTHROUGH && process.env.ANTIFEED_LOOP_URL ? [here("../projects/isomux/signoff-walkthrough.ts")] : [])]
  : [...(INBOX ? [here("../projects/inbox/policies.ts")] : []), ...(TRIAGE ? [here("../projects/isomux/policies.ts")] : []), ...(WALLGAME ? [here("../projects/wallgame/policies.ts")] : [])];
// Nil, 2026-10-31 (through Isomux PM; DESIGN.md 22): Isomux decision work moves
// off Antifeed into the Isomux Inbox, as asks the Isomux crew opens. These
// kinds are switched off; their waiting cards are withdrawn at start with this reason.
export const MOVED_NOTE = "Every kind moved to the Isomux Inbox (Nil, 2026-10-31): Isomux triage and sign-off, your asks and pages, and Wall Game triage and video approvals. You answer them there as asks; Antifeed makes no new packets.";
export const MOVED_TO_INBOX = { policies: ["triage", "signoff", "ask", "page", "wallgame-video", "wallgame-triage"], reason: "Moved to the Isomux Inbox (Nil, 2026-10-31)." };
// Live mode: the loop app's applied triage calls become triage precedent, once.
export const LOOP_SEED = { policy: "triage", project: "isomux", source: "isomux-loop" };

// A confirm of a Premove at this calibrated confidence or more is not an
// effective decision (Nil, 2026-10-26; DESIGN.md 15). One value for every
// policy for now.
export const EFFECTIVE_MIN_CONFIDENCE = 0.9;

export const CLOCK_MS = 5_000;
export const HELD_MS = 1_000;
export const DISPATCH_MS = 15_000;
export const BOARD_MS = 60_000;
// How often the Inbox source reads Nil's asks and pages (DESIGN.md 14.1).
export const INBOX_MS = 10_000;
// Part J: how often the Loop app's Sign-off list is read, and where the Loop
// app is (a copy for a check: ANTIFEED_LOOP_URL).
export const LOOP_MS = 15_000;
export const LOOP_URL = (process.env.ANTIFEED_LOOP_URL || "http://127.0.0.1:21025").replace(/\/$/, "");
// How long a decider may take before its card goes to Nil unpredicted.
export const PREDICT_TIMEOUT_MS = 120_000;
// The predictor and consult runs (claude -p): a cap per run and per day.
export const RUN_MAX_USD = 0.5;
export const PREDICTOR_DAILY_RUNS = 300;
// The consult agent (DESIGN.md 13.1): how long a card waits for it to start
// its predict, and to answer after the start, before the stand-in runs.
export const PREDICT_START_MS = WALKTHROUGH ? 5_000 : 120_000;
export const PREDICT_ANSWER_MS = WALKTHROUGH ? 15_000 : 600_000;
export const STANDIN_MODEL = "sonnet";
// Nil's office in a browser (links on cards: an agent's chat, an ask's page).
export const OFFICE_URL = "https://office.example.com";
// The office page with the app and, beside it, the chat of the agent Nil
// talks to about the app itself: Antifeed PM, the app's owner and chat
// target (Nil, 2026-10-28). Questions about a card go to its project's
// consult, in that agent's own chat.
export const CHAT_URL = "https://office.example.com/antifeed";
export const CHAT_AGENT = "Antifeed PM";
export const AGENTS_MS = 30_000;
