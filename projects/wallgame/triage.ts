// Wall Game triage (DESIGN.md section 16): an open task on the Wall Game
// board with no assignee, P0-P3 or no priority, and no call line of Nil's
// gets a card. Code makes the packet from the task; Wall Game Consult's call is
// the Premove. Nil's call goes to Wall Game PM in one message per burst
// (wallgame.apply); Antifeed never writes the Wall Game board, and it sees
// the call land when the call line is on the board.
import { OFFICE_URL } from "../../src/config";
import { wholeTitle } from "../../src/validate";
import type { Call, CommandAbout, Event, Landing, OutItem, Packet, Policy } from "../../src/types";

export type WTask = { title: string; priority: string | null; status: string; assignee: string | null; description: string; createdBy: string; createdAt: number };
// seen: the task as Nil saw it when he decided (shown()).
type Pending = { call: Call; decidedAt: string; seen?: string };
export type Sent = { task: string; title: string; call: Call; decidedAt: string; sentAt: string; landedAt: string | null };
export type WallgameState = {
  tasks: Record<string, WTask>;
  // task id -> its card while the card is live (open, or decided and not yet sent)
  card: Record<string, string>;
  cardTask: Record<string, string>;
  cardState: Record<string, "open" | "decided">;
  // card -> the wallgame.apply command that is not finished
  apply: Record<string, string>;
  // card -> Nil's call, from its decision until the send
  pending: Record<string, Pending>;
  // card -> the call that went to Wall Game PM, and when its line was on the board
  sent: Record<string, Sent>;
  // card -> true while its wallgame.apply runs (the message is going out)
  going: Record<string, boolean>;
  // card -> its wallgame.apply that failed, while its failure card waits (B1)
  failed: Record<string, string>;
  // a retry's command -> the failed command it sends again (slice 8 walk)
  retryOf: Record<string, string>;
};


export const CALLS = ["go", "design", "hold", "backlog", "obsolete"] as const;
const PRIORITIES = ["P0", "P1", "P2", "P3"];
// A call line (Antifeed PM, 2026-10-26, A): "Nil, <date>:" and then a call
// word, at the start of a line. Nil's reports ("Nil, 2026-07-29: after
// beating a campaign level...") are not calls.
const CALL_LINE = /^Nil, (\d{4}-\d{2}-\d{2}):\s*(go|design|hold|backlog|obsolete)\b/gim;
export function callLines(description: string): { date: string; call: string }[] {
  return [...description.matchAll(CALL_LINE)].map((m) => ({ date: m[1], call: m[2].toLowerCase() }));
}

// F1 (Antifeed Reviewer, 2026-10-26): a call whose task no longer waits for
// it does not go out, as an ask's reply (slice 7).
export const notSent = (why: string) => `Not sent. ${why}`;
export const NOT_SENT_CHANGED = notSent("The task changed on the board after your call. A new card shows it as it is now.");
// A retry of a call that no longer waits for one (slice 8 walk).
export const NOT_SENT_AGAIN = notSent("This call was dropped or taken back before, so it does not go out again.");

export const GO_LINE = "go allows the work up to a deploy, push, prod write or bot restart. Those still need your word in an ask.";
export const UNDO_WORDS = "Your call went to Wall Game PM; it cannot be taken back.";

// Why a task gets no card, in words for the Decided tab; null when it gets one.
export function whyNot(t: WTask): string | null {
  if (t.status === "done" || t.status === "obsolete") return "The task was closed on the board.";
  if (t.status === "gone") return "The task left the Wall Game board.";
  if (t.assignee) return `${t.assignee} took the task on the board.`;
  if (t.status !== "open") return `The task is ${t.status.replace(/_/g, " ")} on the board.`;
  if (t.priority !== null && !PRIORITIES.includes(t.priority)) return `The task moved to ${t.priority} on the board.`;
  if (callLines(t.description).length) return "Nil decided it on the board.";
  return null;
}

// Nil's date in Pacific time ("2026-10-26"), and the time of a call ("6:41 AM PT").
export const ptDate = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
const ptTime = (at: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(at)) + " PT";

// The call in board words: "go P1", "backlog".
export const callWords = (c: Call) => [c.choice, c.priority].filter((v) => v).join(" ");
// The line Wall Game PM writes at the top of the task's description.
export function boardLine(c: Call, decidedAt: string): string {
  const note = (c.note ?? "").trim();
  return `Nil, ${ptDate(decidedAt)}: ${callWords(c)}.${note ? ` ${note}` : ""}`;
}
// The call has landed: a call line with its call word, dated on or after the call's day.
export function landed(description: string, c: Call, decidedAt: string): boolean {
  const day = ptDate(decidedAt);
  return callLines(description).some((l) => l.call === c.choice && l.date >= day);
}

// One call's block in the message to Wall Game PM (DESIGN.md 16.5).
// A field's later lines are indented by two spaces, so a note of several
// lines shows where it ends.
const field = (label: string, text: string) => `${label}: ${text.replace(/\n/g, "\n  ")}`;
export function messageBlock(p: { task: string; title: string; card: string; call: Call; decidedAt: string }, api: string): string {
  const note = (p.call.note ?? "").trim();
  return [
    `${p.task} "${p.title}"`,
    `Call: ${callWords(p.call)} (Nil, ${ptDate(p.decidedAt)} ${ptTime(p.decidedAt)})`,
    field("Note", note || "none"),
    field("Board line", boardLine(p.call, p.decidedAt)),
    `Check: curl -s ${api}/api/cards/${p.card}/context`,
  ].join("\n");
}
// P2 (Antifeed Reviewer, 2026-10-26): the head says that the app sends Nil's
// calls, so the message does not read as Nil writing. Titles come from the
// board, in quotes.
export function messageText(blocks: string[]): string {
  const one = blocks.length === 1;
  return [
    `Antifeed: the Antifeed app sends you ${one ? "1 triage call" : `${blocks.length} triage calls`} that Nil made in Antifeed (his decision queue) on ${one ? "a Wall Game task" : "Wall Game tasks"}. Nil did not write this message. ${one ? "Write its" : "For each, write its"} board line at the top of the task's description as it is, and set the task's priority to the call's (backlog: P4; obsolete: close the task). Then do the work in priority order. go: do it, up to a deploy, push, prod write or bot restart; those still need Nil's word in an ask. design: a design packet for Nil first. hold: do not touch it. Antifeed reads the board and shows Nil when ${one ? "the" : "each"} board line is there. Check reads the same call in Antifeed, read only. A line indented by two spaces goes on with the field above it.`,
    ...blocks,
  ].join("\n\n");
}

const SOURCE = "Wall Game board";

function packetOf(id: string, t: WTask): Packet {
  const by = t.createdBy ? `Filed by ${t.createdBy}` : "Filed";
  const when = t.createdAt ? ` on ${ptDate(new Date(t.createdAt).toISOString())}` : "";
  return {
    // A title the office cut is not the question (Nil, 2026-10-30).
    question: wholeTitle(t.title, t.description),
    blocks: [
      { type: "markdown", text: `${by}${when}. Priority on the board: ${t.priority ?? "none"}. Task ${id}.` },
      { type: "markdown", text: t.description.trim() || "The task has no description." },
    ],
  };
}

// The call in Nil's words, for Status and its failure card (slice 8 walk:
// no ids or actor names in view; the task id goes in the ids fold).
function about(task: string, t: WTask | undefined, call: Call): CommandAbout {
  const title = t?.title ?? task;
  const note = (call.note ?? "").trim();
  return {
    title: `Your call to Wall Game PM: ${title}`,
    one: "Your call to Wall Game PM",
    many: "Your {n} calls to Wall Game PM",
    label: "Task",
    name: title,
    rows: [["Your call", callWords(call)], ...(note ? [["Note", note] as [string, string]] : [])],
    ids: [["Task", task]],
    to: "Wall Game PM",
    noReassign: true,
  };
}

export const snapshot = (d: Record<string, any>, before?: WTask): WTask => ({
  title: d.title ?? before?.title ?? "",
  priority: d.priority ?? null,
  status: d.status ?? "open",
  assignee: d.assignee ?? null,
  description: d.description ?? before?.description ?? "",
  createdBy: d.createdBy ?? before?.createdBy ?? "",
  createdAt: d.createdAt ?? before?.createdAt ?? 0,
});
// What Nil reads on the card: a change to it replaces a waiting card.
export const shown = (t: Pick<WTask, "title" | "priority" | "description">) => JSON.stringify([t.title, t.priority, t.description]);

export const wallgameTriage: Policy<WallgameState> = {
  id: "wallgame-triage",
  name: "Triage",
  color: "#2f6f4f",
  on: ["board.task.seen", "board.task.filed", "board.task.changed", "board.task.closed"],
  emits: ["wallgame.decided"],
  final: ["wallgame.decided"],
  commands: {
    // Nil decides in bursts: Wall Game PM hears once he paused 3 minutes, as isomux triage's Curator does.
    // notifyDrop: a dropped failure frees the task for a new card (B1).
    "wallgame.apply": { actor: "wgpm", delivery: "at-most-once", burstMs: 180_000, what: "send your call to Wall Game PM", when: "After your call, once you pause 3 minutes", notifyDrop: true },
  },
  decider: { kind: "nil", predictor: { kind: "consult", criteria: "triage-criteria.md" } },
  autoAllowed: false,
  answer: {
    choice: { enum: [...CALLS], label: "Call", help: GO_LINE },
    priority: { enum: ["P0", "P1", "P2", "P3", null], label: "Priority", needs: { choice: ["go", "design", "hold"] }, noneWith: { choice: ["backlog", "obsolete"] } },
  },
  primary: ["choice"],
  // No basis for a Premove: backlog, which never raises a task.
  fallback: { choice: "backlog", priority: null },
  fallbackHelp: "backlog: P4 on the Wall Game board, where no agent picks it",
  undoUntilSent: UNDO_WORDS,
  // Code makes the packet from the task: no author agent (slice 8 walk).
  noAuthor: true,
  notePlaceholder: "Note: goes to Wall Game PM as you write it",
  init: { tasks: {}, card: {}, cardTask: {}, cardState: {}, apply: {}, pending: {}, sent: {}, going: {}, failed: {}, retryOf: {} },
  reduce(state, e: Event) {
    const s: WallgameState = { tasks: { ...state.tasks }, card: { ...state.card }, cardTask: { ...state.cardTask }, cardState: { ...state.cardState }, apply: { ...state.apply }, pending: { ...state.pending }, sent: { ...state.sent }, going: { ...state.going }, failed: { ...state.failed }, retryOf: { ...state.retryOf } };
    // The call is out of the queue without a send (F1): the task is free for a new card.
    const drop = (c: string) => {
      const t = s.cardTask[c];
      delete s.pending[c];
      delete s.cardState[c];
      if (t && s.card[t] === c) delete s.card[t];
    };
    const openItem = (id: string, t: WTask): OutItem => ({ open: { subject: id, meta: { source: SOURCE, raw: OFFICE_URL, priority: t.priority ?? undefined, createdBy: t.createdBy || undefined }, packet: packetOf(id, t) } });
    // A sent call that is not on the board yet still stands: Wall Game PM
    // may change the task before it writes the call line.
    const unlanded = (id: string) => Object.values(s.sent).some((x) => x.task === id && !x.landedAt);
    // A freed task gets a new card now when it still waits for a call.
    const reopen = (id: string | undefined) => {
      const t = id ? s.tasks[id] : undefined;
      if (id && t && !s.card[id] && !whyNot(t) && !unlanded(id)) out.push(openItem(id, t));
    };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    switch (e.type) {
      case "board.task.seen":
      case "board.task.filed":
      case "board.task.changed":
      case "board.task.closed": {
        const id = e.subject!;
        const before = s.tasks[id];
        const now = snapshot(e.type === "board.task.closed" ? { ...d, status: d.status ?? "done" } : d, before);
        s.tasks[id] = now;
        // A sent call lands when its call line is on the board.
        for (const [c, x] of Object.entries(s.sent)) if (x.task === id && !x.landedAt && landed(now.description, x.call, x.decidedAt)) s.sent[c] = { ...x, landedAt: e.at };
        const card = s.card[id];
        const why = whyNot(now);
        if (!card) {
          if (!why && !unlanded(id)) out.push(openItem(id, now));
          break;
        }
        // A decided card stays: its call is Nil's, and Wall Game PM's board line is a change.
        // F1: a call that has not started to go out is not sent when its task
        // no longer waits for it; a changed task gets a new card, as an ask does.
        if (s.cardState[card] !== "open") {
          const k = s.apply[card];
          if (!k || s.going[card]) break;
          if (why) out.push({ cancel: k, reason: notSent(why) });
          else if (before && shown(before) !== shown(now)) {
            out.push({ cancel: k, reason: NOT_SENT_CHANGED });
            out.push(openItem(id, now));
          }
          break;
        }
        if (why) out.push({ withdraw: card, reason: why });
        else if (before && shown(before) !== shown(now)) {
          out.push({ withdraw: card, reason: "The task changed on the board: a new card shows it as it is now." });
          out.push(openItem(id, now));
        }
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        s.cardTask[e.card!] = e.subject!;
        s.cardState[e.card!] = "open";
        break;
      case "card.withdrawn": {
        const t = s.cardTask[e.card!];
        if (t && s.card[t] === e.card) delete s.card[t];
        delete s.cardState[e.card!];
        break;
      }
      case "card.decided": {
        const task = s.cardTask[e.card!];
        if (!task) break;
        s.cardState[e.card!] = "decided";
        s.pending[e.card!] = { call: d.call, decidedAt: e.at, ...(s.tasks[task] ? { seen: shown(s.tasks[task]) } : {}) };
        out.push({ emit: { type: "wallgame.decided", subject: task, data: { call: d.call } } });
        // seen: the task as Nil saw it, so the send drops the call if it changed since (F1).
        const t = s.tasks[task];
        out.push({ issue: { type: "wallgame.apply", card: e.card, subject: task, params: { taskId: task, title: t?.title ?? task, call: d.call, decidedAt: e.at, seen: t ? { title: t.title, priority: t.priority, description: t.description } : null }, about: about(task, t, d.call) } });
        break;
      }
      case "card.undone": {
        // Only inside the Undo time: after the send the engine refuses the Undo (undoUntilSent).
        const t = s.cardTask[e.card!];
        s.cardState[e.card!] = "open";
        delete s.pending[e.card!];
        if (s.apply[e.card!]) out.push({ cancel: s.apply[e.card!] });
        if (t && s.card[t] && s.card[t] !== e.card) out.push({ withdraw: e.card!, reason: "A newer card of this task is in the queue." });
        else if (t && whyNot(s.tasks[t])) out.push({ withdraw: e.card!, reason: whyNot(s.tasks[t])! });
        else if (t) s.card[t] = e.card!;
        break;
      }
      case "command.issued":
        if (d.type !== "wallgame.apply" || !d.card) break;
        // A retry goes only while its failed call holds the task: after a
        // drop the task may have a new card, so the old call never goes too.
        if (d.reissue && s.failed[d.card] !== d.reissue) {
          out.push({ cancel: e.command!, reason: NOT_SENT_AGAIN });
          break;
        }
        // A retry: the call is live again, so the task gets no new card.
        s.apply[d.card] = e.command!;
        if (d.reissue) s.retryOf[e.command!] = d.reissue;
        delete s.failed[d.card];
        break;
      case "command.dropped":
        // B1: Nil dropped the failed call: the task is free, and gets a new
        // card if it still waits. If the call did reach Wall Game PM, its
        // call line withdraws that card.
        for (const [c, k] of Object.entries(s.failed))
          if (k === e.command) {
            const t = s.cardTask[c];
            delete s.failed[c];
            drop(c);
            reopen(t);
          }
        break;
      case "command.started":
        for (const [c, k] of Object.entries(s.apply)) if (k === e.command) s.going[c] = true;
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        for (const [c, k] of Object.entries(s.apply))
          if (k === e.command) {
            delete s.apply[c];
            delete s.going[c];
            const t = s.cardTask[c];
            const p = s.pending[c];
            const was = s.retryOf[e.command!];
            delete s.retryOf[e.command!];
            // Nil took back the retry's call: the failed call holds the task again.
            if (e.type === "command.cancelled" && d.undone && was) {
              s.failed[c] = was;
              continue;
            }
            // Not sent (F1): cancelled with a reason while the card stays
            // decided (an Undo opens the card first), or dropped just before the send.
            if ((e.type === "command.cancelled" && s.cardState[c] === "decided") || (e.type === "command.done" && d.result?.notSent)) {
              drop(c);
              // The board source saw the change before the send (a retry
              // after a change): no new board event comes, so the card opens now.
              // Otherwise the source's next read opens it.
              if (e.type === "command.done" && p && t && s.tasks[t] && p.seen !== shown(s.tasks[t])) reopen(t);
              continue;
            }
            if (e.type === "command.failed") s.failed[c] = e.command!;
            // Sent: the task is free for a new card if it ever needs triage
            // again. A failure keeps the card decided; its failure card offers the retry.
            if (e.type === "command.done" && t && p) {
              delete s.pending[c];
              if (s.card[t] === c) delete s.card[t];
              s.sent[c] = { task: t, title: s.tasks[t]?.title ?? t, call: p.call, decidedAt: p.decidedAt, sentAt: e.at, landedAt: landed(s.tasks[t]?.description ?? "", p.call, p.decidedAt) ? e.at : null };
            }
          }
        break;
    }
    return { state: s, out };
  },
  landing: (s) => Object.entries(s.sent).map(([card, x]) => ({ card, subject: x.task, title: x.title, call: callWords(x.call), to: "Wall Game PM", sentAt: x.sentAt, landedAt: x.landedAt })),
};

export type { Landing };
