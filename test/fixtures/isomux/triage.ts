// Triage, as DESIGN.md section 8 describes it, small enough for tests.
import type { Event, OutItem, Policy } from "../../../src/types";

type Task = { title: string; priority: string; status: string };
export type TriageState = {
  tasks: Record<string, Task>;
  card: Record<string, string>; // task id -> open card
  apply: Record<string, string>; // card -> triage.apply command not finished
};

const tagged = (title: string) => /^\[\s*[a-z]+\s*\|[^\]]*\]/.test(title);
const wants = (t: Task) => t.status === "open" && ["P0", "P1", "P2", "P3"].includes(t.priority) && !tagged(t.title);

export const triage: Policy<TriageState> = {
  id: "triage",
  on: ["board.task.seen", "board.task.filed", "board.task.changed", "board.task.closed"],
  emits: ["triage.decided"],
  final: ["triage.decided"],
  commands: {
    "triage.prepare": { actor: "curator", delivery: "at-least-once" },
    "triage.apply": { actor: "curator", delivery: "at-least-once", burstMs: 180_000, timeoutMs: 3_600_000 },
    "triage.ask-nil": { actor: "nil", delivery: "at-most-once" },
  },
  decider: { kind: "threshold", agent: { kind: "agent", model: "fake", criteria: "criteria.md" }, min: 0.9 },
  autoAllowed: true,
  author: "curator",
  prepare: "triage.prepare",
  answer: {
    choice: { enum: ["go", "design", "hold", "backlog", "obsolete"] },
    priority: { enum: ["P0", "P1", "P2", "P3", null] },
    title: { text: { max: 500 } },
  },
  primary: ["choice"],
  fallback: { choice: "backlog", priority: null },
  validate: (c) => (["go", "design", "hold"].includes(c.choice ?? "") && !c.priority ? `${c.choice} needs a priority` : null),
  init: { tasks: {}, card: {}, apply: {} },
  reduce(state, e: Event) {
    const s: TriageState = { tasks: { ...state.tasks }, card: { ...state.card }, apply: { ...state.apply } };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    switch (e.type) {
      case "board.task.seen":
      case "board.task.filed":
      case "board.task.changed": {
        const id = e.subject!;
        s.tasks[id] = { title: d.title, priority: d.priority, status: d.status ?? "open" };
        const card = s.card[id];
        if (!card && wants(s.tasks[id]))
          out.push({ open: { subject: id, meta: { raw: `board:${id}`, priority: d.priority }, prepare: { type: "triage.prepare", params: { taskId: id } } } });
        else if (card && e.type === "board.task.changed" && !d.byApply) out.push({ issue: { type: "triage.prepare", card, params: { taskId: id, revise: "task changed after packet" } } });
        break;
      }
      case "board.task.closed": {
        const id = e.subject!;
        if (s.tasks[id]) s.tasks[id] = { ...s.tasks[id], status: "done" };
        if (s.card[id]) out.push({ withdraw: s.card[id] });
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        break;
      case "card.withdrawn":
        for (const [t, c] of Object.entries(s.card)) if (c === e.card) delete s.card[t];
        break;
      case "card.decided": {
        const taskId = Object.entries(s.card).find(([, c]) => c === e.card)?.[0];
        if (!taskId) break;
        out.push({ emit: { type: "triage.decided", subject: taskId, data: { call: d.call } } });
        out.push({ issue: { type: "triage.apply", card: e.card, subject: taskId, params: { taskId, call: d.call, decidedAt: e.at } } });
        break;
      }
      case "card.undone":
        if (s.apply[e.card!]) out.push({ cancel: s.apply[e.card!] });
        break;
      case "command.issued":
        if (d.type === "triage.apply" && d.card) s.apply[d.card] = e.command!;
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        for (const [c, k] of Object.entries(s.apply)) if (k === e.command) delete s.apply[c];
        break;
    }
    return { state: s, out };
  },
};
