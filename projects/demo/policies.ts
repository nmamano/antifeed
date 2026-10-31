// Demo project: cards of each shape, so Nil can look at the page before
// isomux moves in. Its packets come with its seed. Its Premoves come from
// Isomux Consult, the consult agent (DESIGN.md 13.1), as for isomux; in the
// reviewer's walkthrough copy, from a code stub that plays each Premove state
// (DESIGN.md 13.4). Its actions go to a code clerk that only says "done". It
// reads and writes nothing outside the app.
import { readFileSync } from "node:fs";
import { WALKTHROUGH } from "../../src/config";
import type { CommandRec } from "../../src/engine";
import { definePolicies, type RunContext } from "../../src/policies";
import type { Event, OutItem, Packet, Policy, Prediction } from "../../src/types";
import { seed } from "./seed";

// walk: the Premove state this card plays in the walkthrough copy.
export type Walk = "agent" | "informed" | "claude" | "vote" | "late";
export type Item = { id: string; policy: string; packet?: Packet; meta?: Record<string, string>; premove?: Omit<Prediction, "by" | "precedent">; action?: Packet; walk?: Walk; lateMs?: number };
// apply: card -> its demo.apply that has not finished, so an Undo cancels it.
type S = { premoves: Record<string, Item["premove"]>; apply?: Record<string, string> };

const reduce = (policy: string) => (state: S, e: Event): { state: S; out?: OutItem[] } => {
  if (e.type === "demo.item" && e.data.policy === policy) {
    const it = e.data as Item;
    const out: OutItem[] = it.packet ? [{ open: { subject: it.id, meta: { ...it.meta, raw: `demo:${it.id}` }, packet: it.packet } }] : [];
    if (it.action) out.push({ issue: { type: "demo.ask-nil", subject: it.id, params: {}, packet: it.action } });
    return { state: { premoves: { ...state.premoves, [it.id]: it.premove } }, out };
  }
  if (e.type === "card.decided" && !e.data.generic) return { state, out: [{ issue: { type: "demo.apply", card: e.card, subject: e.subject, params: { call: e.data.call } } }] };
  // Round 9: the apply waits for the call's Undo time (the dispatcher), and an Undo in that time cancels it.
  if (e.type === "command.issued" && e.data.type === "demo.apply" && e.data.card) return { state: { ...state, apply: { ...state.apply, [e.data.card]: e.command! } } };
  if (e.type === "card.undone" && state.apply?.[e.card!]) return { state, out: [{ cancel: state.apply[e.card!] }] };
  if ((e.type === "command.done" || e.type === "command.failed" || e.type === "command.cancelled") && Object.values(state.apply ?? {}).includes(e.command!))
    return { state: { ...state, apply: Object.fromEntries(Object.entries(state.apply!).filter(([, k]) => k !== e.command)) } };
  return { state };
};

// In the walkthrough copy a code author plays the packet creator of every
// demo kind, so New packet and Closer to this option can be walked (round
// Q1, C4). All three kinds keep one shape, so Flow shows them as one table.
const common = {
  on: ["demo.item"],
  emits: [],
  commands: {
    "demo.apply": { actor: "clerk", delivery: "at-least-once" as const, what: "carry out your call", when: "After your call" },
    "demo.ask-nil": { actor: "nil", delivery: "at-most-once" as const, what: "a step that only you can do", when: "For a demo item that needs your hands" },
    ...(WALKTHROUGH ? { "demo.prepare": { actor: "creator", delivery: "at-least-once" as const, what: "write the packet again", when: "When you ask for a new packet or for options closer to one" } } : {}),
  },
  ...(WALKTHROUGH ? { prepare: "demo.prepare", author: "creator" } : {}),
  decider: { kind: "nil" as const, predictor: { kind: "consult" as const, criteria: "demo-criteria.md" } },
  init: { premoves: {} } as S,
};

const choiceAndPriority = {
  choice: { enum: ["go", "design", "hold", "backlog", "obsolete"], label: "Call" },
  priority: { enum: ["P0", "P1", "P2", "P3", null], label: "Priority", needs: { choice: ["go", "design", "hold"] }, noneWith: { choice: ["backlog", "obsolete"] } },
};
const triage: Policy<S> = {
  ...common,
  id: "demo-triage",
  name: "Triage",
  color: "#8a6d00",
  answer: { ...choiceAndPriority, title: { text: { max: 500 }, label: "New title", help: "Only if the task should be renamed on the board." } },
  primary: ["choice"],
  fallback: { choice: "backlog", priority: null },
  reduce: reduce("demo-triage"),
};
// A worker's design question: options from the worker, your pick is the design.
const design: Policy<S> = {
  ...common,
  id: "demo-design",
  name: "Design question",
  color: "#0f8a6a",
  answer: choiceAndPriority,
  primary: ["choice"],
  fallback: { choice: "hold", priority: "P3" },
  reduce: reduce("demo-design"),
};
const reply: Policy<S> = {
  ...common,
  id: "demo-reply",
  name: "Reply",
  color: "#2f6fde",
  answer: { choice: { enum: ["send", "hold", "skip"], label: "Call" } },
  primary: ["choice"],
  fallback: { choice: "hold" },
  reduce: reduce("demo-reply"),
};

export default definePolicies({
  project: "demo",
  actors: [
    { id: "clerk", kind: "code", handler: "done" },
    { id: "nil", kind: "human", member: "Nil" },
    WALKTHROUGH ? { id: "consult", kind: "code", handler: "walkthrough-stub" } : { id: "consult", kind: "agent", agentName: "Isomux Consult", skill: "antifeed-consult" },
    ...(WALKTHROUGH ? [{ id: "creator", kind: "code" as const, handler: "walkthrough-creator" }] : []),
  ],
  consult: "consult",
  consultInfo: { handoffTokens: 300_000, instructions: readFileSync(new URL("../isomux/antifeed-consult/SKILL.md", import.meta.url), "utf8") },
  sources: [{ id: "seed", kind: "demo-seed" }],
  events: { "demo.item": { from: "seed", what: "a demo item from the seed list" } },
  policies: [triage, design, reply],
  run: {
    done: () => ({ done: true }),
    // The walkthrough's author of design cards: a new packet as Nil's note
    // asks, or variants of the option he picked. It keeps the card's meta.
    "walkthrough-creator": (k: CommandRec, ctx: RunContext) => {
      const c = ctx.card(k.card!);
      if (!c?.packet) throw new Error("the card has no packet to write again");
      const q = k.params as { revise?: string; refine?: string };
      const v = c.version + 1;
      if (q.refine) {
        const o = (c.packet.options ?? []).find((x) => x.id === q.refine);
        if (!o) throw new Error(`the packet has no option ${q.refine}`);
        const base = String(o.label).replace(/^[A-Za-z0-9]{1,2}[.)]\s*/, "");
        const options = ["P0", "P1", "P2"].map((pr, i) => ({ id: `${o.id}${i + 1}`, label: `${o.id.toUpperCase()}${i + 1}. ${base}, at ${pr}`, ...(o.cost ? { cost: o.cost } : {}), fill: { ...o.fill, priority: pr } }));
        return { packet: { ...c.packet, blocks: [{ type: "markdown", text: `Version ${v}: three variants of option ${o.id.toUpperCase()}, as you asked.` }, ...c.packet.blocks], options, recommended: options[1].id }, meta: { ...c.meta } };
      }
      return { packet: { ...c.packet, blocks: [{ type: "markdown", text: `Version ${v}, written again as your note asked: "${q.revise ?? ""}".` }, ...c.packet.blocks] }, meta: { ...c.meta } };
    },
    // The walkthrough stub: it answers as its seed item's walk says.
    "walkthrough-stub": (k: CommandRec) => {
      const it = (seed as Item[]).find((x) => x.id === k.subject);
      const p = it?.premove;
      if (!it || !p || it.walk === "claude" || it.walk === "vote") return { skip: true };
      const prediction = { ...p, ...(it.walk === "informed" ? { informed: true } : {}) };
      return it.walk === "late" ? { delayMs: it.lateMs ?? 25_000, prediction } : { prediction };
    },
  },
});
