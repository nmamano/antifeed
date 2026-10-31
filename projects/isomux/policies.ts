// Isomux's policies (DESIGN.md section 6). Kept in the antifeed repo until
// Nil wants them public (Nil, 2026-10-25, Q2 A).
import { readFileSync } from "node:fs";
import { definePolicies } from "../../src/policies";
import { triage } from "./triage";
import { signoffParts } from "./signoff";

// Part J: sign-off, behind SIGNOFF_IN_ANTIFEED (projects/isomux/signoff.ts).
const so = signoffParts();

// The isomux project's consult agent, in the Isomux room: it predicts each
// isomux card, and Nil asks it about a card in its own chat (Nil, 2026-10-28:
// each project has its own consult, in the project's room).
export const CONSULT = "Isomux Consult";

export default definePolicies({
  project: "isomux",
  actors: [
    { id: "curator", kind: "agent", agentName: "Isomux Curator", skill: "isomux-curator" },
    { id: "nil", kind: "human", member: "Nil" },
    // Predicts each card and answers Nil in its own chat (DESIGN.md 13.1).
    { id: "consult", kind: "agent", agentName: CONSULT, skill: "antifeed-consult" },
    ...so.actors,
  ],
  consult: "consult",
  consultInfo: { handoffTokens: 300_000, instructions: readFileSync(new URL("./antifeed-consult/SKILL.md", import.meta.url), "utf8") },
  sources: [{ id: "board", kind: "isomux-board", roomId: "e6818e47" }, ...so.sources],
  events: {
    "board.task.seen": { from: "board", what: "a task that was on the board at the first read" },
    "board.task.filed": { from: "board", what: "a new task on the board" },
    "board.task.changed": { from: "board", what: "a task that changed on the board" },
    "board.task.closed": { from: "board", what: "a task that left the board: done, obsolete, moved to another room or deleted" },
    "triage.decided": { from: "triage", what: "your triage call on a task" },
    ...so.events,
  },
  policies: [triage, ...so.policies],
  handlers: so.handlers,
  run: so.run,
  agents: {
    "Isomux Curator": "writes each triage packet and writes Nil's calls to the board",
    [CONSULT]: "predicts Nil's call on each isomux packet and answers his questions about them in its own chat; read-only by instruction",
    ...so.agents,
  },
});
