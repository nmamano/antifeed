// Isomux triage (DESIGN.md section 8): an open P0-P3 task in the Isomux room
// with no [class | state] tag gets a card. The Curator writes the packet
// (triage.prepare) and, after Nil's call, writes it to the board
// (triage.apply). Nil decides; Isomux Consult's call is the Premove.
import type { Event, OutItem, Policy, SubjectInfo } from "../../src/types";

export type Task = { title: string; priority: string | null; status: string; description?: string; createdAt?: number | null };
export type TriageState = {
  tasks: Record<string, Task>;
  // task id -> its card while the card is live (not withdrawn, its call not yet on the board)
  card: Record<string, string>;
  // card -> its task, for every card this policy opened
  cardTask: Record<string, string>;
  // card -> its state as this policy knows it
  cardState: Record<string, "waiting" | "open" | "decided">;
  // card -> a triage.apply was issued since the card's last packet: a board
  // change then is most likely the Curator's own write.
  applied: Record<string, boolean>;
  // card -> a triage.apply finished since the card's last packet
  wrote: Record<string, boolean>;
  // card -> the triage.apply command that is not finished
  apply: Record<string, string>;
};

export const LOOP_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const tagged = (title: string) => /^\[\s*[a-z]+\s*\|[^\]]*\]/.test(title);
// As the loop app's unclassified() (src/loop.ts): an open task with no tag,
// P0-P3 or no priority yet (a task filed with no priority needs triage too).
export const wantsTriage = (t: Task) => t.status === "open" && (t.priority == null || LOOP_PRIORITIES.includes(t.priority)) && !tagged(t.title);
// Why a waiting card is withdrawn, in words (Antifeed PM, 2026-10-31): its
// task no longer wants triage.
export function whyNoTriage(t: Task): string {
  const tag = /^\[[^\]]*\]/.exec(t.title)?.[0];
  if (t.status === "done" || t.status === "obsolete") return "Closed on the board.";
  if (t.status !== "open") return `The task is ${t.status.replace(/_/g, " ")} on the board.`;
  if (tag && tagged(t.title)) return `Decided on the board: ${tag}.`;
  return `The task moved to ${t.priority} on the board, out of the loop priorities.`;
}

const SOURCE_URL = "https://office.example.com";

// Nil, 2026-10-30 ("yeah", on Isomux PM's finding: the Loop app's triage card
// got 553 calls in 10 days, Antifeed's shape cards none): isomux triage cards
// are the Loop app's card. Take this line out and restart for the card kind
// every other policy has; the log and the decisions stay valid both ways.
export const CARD_KIND = "loop" as const;


export const triage: Policy<TriageState> = {
  id: "triage",
  name: "Triage",
  color: "#8a6d00",
  on: ["board.task.seen", "board.task.filed", "board.task.changed", "board.task.closed"],
  emits: ["triage.decided"],
  final: ["triage.decided"],
  commands: {
    "triage.prepare": { actor: "curator", delivery: "at-least-once", timeoutMs: 2 * 3_600_000, what: "write the triage packet of a task", when: "For each new task, again when it changes, and when you ask for a new packet" },
    // Nil decides in bursts: the Curator hears once he paused 3 minutes (the loop app's TRIAGE_QUIET_MS).
    "triage.apply": { actor: "curator", delivery: "at-least-once", burstMs: 180_000, timeoutMs: 2 * 3_600_000, what: "write your call to the board", when: "After your call, once you pause 3 minutes" },
  },
  // Isomux Consult predicts (DESIGN.md 13.1); claude -p and a code vote are its stand-ins.
  decider: { kind: "nil", predictor: { kind: "consult", criteria: "triage-criteria.md" } },
  // Nil may switch triage to a threshold later; it starts with him, like every policy.
  autoAllowed: true,
  // Nil, 2026-10-29: "i should have never been shown code".
  plainWords: true,
  cardKind: CARD_KIND,
  subjectInfo: (s: TriageState, id: string): SubjectInfo | null => {
    const t = s.tasks[id];
    return t ? { title: t.title, priority: t.priority, description: t.description ?? "", createdAt: t.createdAt ?? null } : null;
  },
  author: "curator",
  prepare: "triage.prepare",
  answer: {
    choice: { enum: ["go", "design", "hold", "backlog", "obsolete"], label: "Call" },
    priority: { enum: ["P0", "P1", "P2", "P3", null], label: "Priority", needs: { choice: ["go", "design", "hold"] }, noneWith: { choice: ["backlog", "obsolete"] } },
    // An option fills them; the Curator writes them to the task. Nil's call
    // is the task's shape (Nil, 2026-10-29): the option he started from is
    // compared with the Premove's (src/decisions.ts outcome).
    scope: { text: { max: 4000 }, label: "Scope", help: "What the task becomes: it goes to the board as the task's new scope.", inLine: "option" },
    title: { text: { max: 500 }, label: "New title", help: "Only if the task should be renamed on the board." },
  },
  primary: ["choice"],
  // No basis for a Premove: backlog, which never raises a task.
  fallback: { choice: "backlog", priority: null },
  init: { tasks: {}, card: {}, cardTask: {}, cardState: {}, applied: {}, wrote: {}, apply: {} },
  reduce(state, e: Event) {
    const s: TriageState = { tasks: { ...state.tasks }, card: { ...state.card }, cardTask: { ...state.cardTask }, cardState: { ...state.cardState }, applied: { ...state.applied }, wrote: { ...state.wrote }, apply: { ...state.apply } };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    switch (e.type) {
      case "board.task.seen":
      case "board.task.filed":
      case "board.task.changed": {
        const id = e.subject!;
        const before = s.tasks[id];
        const now: Task = { title: d.title, priority: d.priority ?? null, status: d.status ?? "open", description: d.description ?? before?.description ?? "", createdAt: d.createdAt ?? before?.createdAt ?? null };
        s.tasks[id] = now;
        const card = s.card[id];
        if (!card) {
          if (wantsTriage(now))
            out.push({ open: { subject: id, meta: { source: "isomux board", raw: SOURCE_URL, priority: now.priority ?? undefined, createdBy: d.createdBy || undefined }, prepare: { type: "triage.prepare", params: { taskId: id } } } });
          break;
        }
        // A card waits for Nil, and no apply of ours came since its packet:
        // a change on the board is someone else's.
        const waiting = s.cardState[card] !== "decided" && !s.applied[card];
        if (!waiting) break;
        if (!wantsTriage(now)) out.push({ withdraw: card, reason: whyNoTriage(now) });
        else if (before && (before.title !== now.title || before.priority !== now.priority)) out.push({ issue: { type: "triage.prepare", card, subject: id, params: { taskId: id, revise: "the task changed on the board after this packet" } } });
        break;
      }
      case "board.task.closed": {
        const id = e.subject!;
        if (s.tasks[id]) s.tasks[id] = { ...s.tasks[id], status: d.status ?? "done" };
        const card = s.card[id];
        if (card && s.cardState[card] !== "decided") out.push({ withdraw: card, reason: "Closed on the board." });
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        s.cardTask[e.card!] = e.subject!;
        s.cardState[e.card!] = "waiting";
        break;
      case "card.packet":
        s.applied[e.card!] = false;
        s.wrote[e.card!] = false;
        s.cardState[e.card!] = "open";
        break;
      case "card.withdrawn": {
        const t = s.cardTask[e.card!];
        if (t && s.card[t] === e.card) delete s.card[t];
        delete s.cardState[e.card!];
        break;
      }
      case "card.decided": {
        // rewrite and refine never reach this policy: the engine asks the Curator itself.
        const taskId = s.cardTask[e.card!];
        if (!taskId) break;
        s.cardState[e.card!] = "decided";
        out.push({ emit: { type: "triage.decided", subject: taskId, data: { call: d.call } } });
        out.push({ issue: { type: "triage.apply", card: e.card, subject: taskId, params: { taskId, call: d.call, version: d.version, decisionAt: e.at } } });
        break;
      }
      case "card.undone": {
        // The card is live again, also after its call reached the board: Nil's next call writes over it.
        const t = s.cardTask[e.card!];
        if (t && !s.card[t]) s.card[t] = e.card!;
        s.cardState[e.card!] = "open";
        if (s.apply[e.card!]) out.push({ cancel: s.apply[e.card!] });
        break;
      }
      case "command.issued":
        if (d.type === "triage.apply" && d.card) {
          s.apply[d.card] = e.command!;
          s.applied[d.card] = true;
        }
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        for (const [c, k] of Object.entries(s.apply))
          if (k === e.command) {
            delete s.apply[c];
            // The call is on the board: the task is free for a new card if it
            // ever needs triage again. An Undo during the apply opened the card
            // again: it keeps its task.
            const t = s.cardTask[c];
            if (e.type === "command.done") {
              s.wrote[c] = true;
              if (t && s.card[t] === c && s.cardState[c] === "decided") delete s.card[t];
            }
            // The apply never wrote: a later board change is someone else's,
            // unless an earlier apply since the packet wrote.
            if (e.type === "command.cancelled") s.applied[c] = !!s.wrote[c];
          }
        break;
    }
    return { state: s, out };
  },
};
