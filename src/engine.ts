// The engine (DESIGN.md sections 2-5): one writer of the event log. An input
// becomes one batch: the input event and every event its reaction causes,
// computed to a fixpoint over all policies, written with one fsync. Replay
// folds the logged events and never acts on a reducer's `out`.

import { DecisionLog } from "./decisions";
import { allowedSwitch, build, type DeciderRuntime, startConfig } from "./deciders";
import { EventLog, type Ids, realIds } from "./log";
import { takeLock } from "./lock";
import { aboutError, checkAgentQuestion, checkPacket, checkCall, codeInPacket, EngineError, snapToOptions } from "./validate";
import { builtinHandlers, commandFailed, BUILTIN_PROJECT, CALL_UNDO_MS } from "./builtin";
import { isGeneric, type LoadedProject, type ProjectDef, type RunContext } from "./policies";
import { outcome } from "./decisions";
import type {
  Actor, ActorRef, Call, Card, CardMeta, CardState, Command, CommandAbout, CommandDecl, CommandState, DecisionLine, DeciderConfig, DeciderStep, Event, EventDraft, Generic, OutItem, Packet, Policy, Prediction,
} from "./types";
import { codeVote, safeDefault } from "./standin";
import { randomBytes } from "node:crypto";

export { EngineError } from "./validate";

// The consult agent's predict command (DESIGN.md 13.1): an engine command,
// owned by no policy's reducer, watched by no failure card.
export const PREDICT = "predict";

// What the engine needs to run predict commands and their stand-ins.
export type PredictRuntime = {
  // The exact text the consult agent gets for a card, and the hash of its criteria.
  // standinText: the stand-in's prompt, with the past calls' lines (precedent: their
  // ids); pastCalls: how many past calls the consult's input names by their route
  // (Nil, 2026-10-29). Without them, the stand-in gets text and the consult precedent.
  input: (policy: string, criteria: string, card: Card, precedent: DecisionLine[]) => { text: string; criteriaHash: string; precedent: string[]; standinText?: string; pastCalls?: number };
  // Stores a text blob; returns its name.
  putBlob: (text: string) => string;
  getBlob: (name: string) => string | null;
  // The consult agent's model, from the office's agent list.
  agentModel: (agentName: string) => string | undefined;
  // The claude -p stand-in: a prediction from the same input text.
  standin: (policy: string, text: string, signal: AbortSignal) => Promise<Omit<Prediction, "precedent">>;
  startMs: number;
  answerMs: number;
};

// batch: the commands that one run of a batch handler took, in order (slice 8).
// reissueOf: the failed command this one sends again. dropped: Nil dropped
// this failed command on its card. detail: the raw cause of a failure.
// deliveredAt: when the dispatcher handed it to its actor.
export type CommandRec = Command & CommandDecl & { state: CommandState; issuedAt: string; deliveredAt?: string; startedAt?: string; doneAt?: string; result?: unknown; error?: string; detail?: string; blocked?: boolean; maybeSent?: boolean; cancelReason?: string; about?: CommandAbout; batch?: string[]; reissueOf?: string; dropped?: boolean; remake?: boolean; superseded?: boolean };
export type Wake = { id: string; policy: string; at: string };
export type ReplayDiff = { event: string; policy: string; expected: string[]; logged: string[] };

type Bound = { policy: Policy; def: ProjectDef; builtin: boolean };

export type EngineOptions = {
  dir: string;
  // Round q1, I: the ids of the places Nil's input can go (config.ts INPUT_TARGETS).
  inputTargets?: string[];
  projects: LoadedProject[];
  runtime: Omit<DeciderRuntime, "handlers">;
  ids?: Ids;
  now?: () => number;
  // How long a decider may take before the card goes to the queue with no prediction.
  predictTimeoutMs?: number;
  // The member who decides; "human:<name>" in the log.
  human?: string;
  // Take the data dir's single-writer lock (default true).
  lock?: boolean;
  // The consult agent's predictions and the stand-ins; without it, a consult
  // predictor's card gets the code stand-in at once.
  predict?: PredictRuntime;
  // Called after a write that issued a command (the dispatcher sends it at once).
  onIssued?: () => void;
  // How long Done or Could not do it on an action card waits for an Undo
  // before the engine sends it (default ACTION_UNDO_MS).
  actionUndoMs?: number;
  // Tests replace the log to simulate a full disk.
  makeLog?: (dir: string, ids: Ids, now: () => number) => EventLog;
};

const MAX_DERIVED = 1000;
// Nil, 2026-10-20 (loop app): the Undo notice lasts 3 times longer, 24 s. The page's toast (UNDO_MS) matches it,
// and the built-in policy holds a drop for it (CALL_UNDO_MS).
export const ACTION_UNDO_MS = CALL_UNDO_MS;
const TERMINAL: CommandState[] = ["done", "failed", "cancelled"];
// A decision card its author can still change or withdraw.
const OPEN: CardState[] = ["preparing", "predicting", "open"];
// Go-live burst, 2026-10-26: 32 predicts in one message reached the consult
// agent as one turn, and none started in time. The dispatcher keeps at most
// this many predicts delivered or started per actor; the rest wait, issued.
export const PREDICT_IN_FLIGHT = 3;
// And 31 claude -p stand-ins at once in the app's 512 MB service swapped:
// none answered in 120 s. One run on a real card took 14 s; 8 at once under
// 512 MB took 61-70 s each; 2 and 4 at once took 12-18 s (2026-10-26).
export const STANDIN_AT_ONCE = 2;
// A remake of a Premove that another project's Predictor made: at most this
// many predicts per card version (remakeForeign).
export const REMAKE_TRIES = 3;
// A re-prepare of many cards (reprepare) keeps this many prepares out at once.
export const REPREPARE_AT_ONCE = 3;

// The chat on a card with its consult (round q1, H1): Nil's words and the
// consult's answers, as chat.* events that no policy hears. They change no
// card state, version or Premove. A text over CHAT_INLINE characters goes in
// a blob.
export const CHAT_MAX = 4_000;
export const CHAT_REPLY_MAX = 8_000;
const CHAT_INLINE = 1_000;
export type ChatState = "sending" | "sent" | "maybe" | "failed" | "answered";
export type ChatMsg = { id: string; card: string; by: ActorRef; at: string; version: number; text?: string; blob?: string; replyTo?: string; replyId?: string; state?: ChatState; error?: string };

// Nil's input that becomes a task (round q1, I): his words, the target (a
// project's room board and its PM agent), the page and packet he wrote them
// on, and how the two office writes went, as input.* events that no policy
// hears. They are not cards and not in the queue.
export const INPUT_MAX = 8_000;
export type InputState = "sending" | "filed" | "told" | "untold" | "failed" | "maybe";
// detail: the office call and its status, for the page's tooltip only (Antifeed PM, 2026-10-29).
export type InputRec = { id: string; at: string; target: string; page: string; card?: string; text?: string; blob?: string; images?: string[]; state: InputState; taskId?: string; error?: string; detail?: string };
// Part K (Nil, 2026-10-30: "i can't attach screenshots to new tasks"): at most 4, each a blob of POST /api/blobs.
export const INPUT_IMAGES_MAX = 4;
export const INPUT_IMAGE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;
export const INPUT_IMAGE_BYTES = 8 * 2 ** 20;

// The words of a predict closed because its card moved on (a new packet, a call, a withdrawal).
export const MOVED_ON = "card moved on";

export class Engine {
  readonly log: EventLog;
  readonly decisions: DecisionLog;
  private ids: Ids;
  private now: () => number;
  private bound = new Map<string, Bound>();
  private states = new Map<string, unknown>();
  readonly cards = new Map<string, Card>();
  readonly commands = new Map<string, CommandRec>();
  readonly wakes = new Map<string, Wake>();
  private deciderSet = new Map<string, { config: DeciderConfig; at: string; member?: string }>();
  // Each card's chat with its consult, oldest first.
  readonly threads = new Map<string, ChatMsg[]>();
  // Nil's inputs, oldest first (round q1, I).
  readonly inputs = new Map<string, InputRec>();
  // Cards a re-prepare asked a new packet for (reprepare): the packet
  // version it asked about, its revise note, and its prepare once issued.
  readonly repreps = new Map<string, { policy: string; version: number; revise: string; command?: string }>();
  private keys = new Set<string>();
  private running = new Set<string>();
  readonly human: ActorRef;
  replayDiffs: ReplayDiff[] = [];
  private live = false;
  // Decider jobs in flight, for tests that wait for them.
  private jobs = new Set<Promise<void>>();
  private unlock: (() => void) | null = null;

  constructor(private opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.ids = opts.ids ?? realIds(this.now);
    this.human = `human:${opts.human ?? "Nil"}`;
    for (const p of opts.projects) for (const policy of p.def.policies) this.bind(policy, p.def, false);
    this.bind(commandFailed, { project: BUILTIN_PROJECT, actors: [], events: {}, policies: [commandFailed], handlers: builtinHandlers }, true);
    if (opts.lock !== false) this.unlock = takeLock(opts.dir);
    this.log = opts.makeLog ? opts.makeLog(opts.dir, this.ids, this.now) : new EventLog(opts.dir, this.ids, this.now);
    this.decisions = new DecisionLog(opts.dir);
    this.replay();
    this.decisions.load(this.log.all());
    this.live = true;
    this.ingest(opts.projects.map((p) => ({ type: "policies.loaded", by: "code:engine", project: p.def.project, data: { path: p.path, hash: p.hash } })));
  }

  private bind(policy: Policy, def: ProjectDef, builtin: boolean): void {
    if (this.bound.has(policy.id)) throw new Error(`policy id "${policy.id}" is used by two projects`);
    this.bound.set(policy.id, { policy, def, builtin });
    this.states.set(policy.id, structuredClone(policy.init));
  }

  // ---- replay -------------------------------------------------------------

  private replay(): void {
    this.cards.clear();
    this.commands.clear();
    this.wakes.clear();
    this.deciderSet.clear();
    this.keys.clear();
    this.threads.clear();
    this.inputs.clear();
    this.repreps.clear();
    for (const b of this.bound.values()) this.states.set(b.policy.id, structuredClone(b.policy.init));
    this.replayDiffs = [];
    const events = this.log.all();
    const derivedBy = new Map<string, Event[]>();
    for (const e of events) if (e.causedBy && e.policy) derivedBy.set(`${e.causedBy}|${e.policy}`, [...(derivedBy.get(`${e.causedBy}|${e.policy}`) ?? []), e]);
    for (const e of events) {
      if (e.type === "batch.end") continue;
      this.project(e);
      // The engine's own reaction to a generic call (its prepare command) is
      // in the log like every derived event: replay does not make it again.
      for (const b of this.subscribers(e)) {
        const r = this.runReducer(b, e);
        // Compare what the code says now with what the log holds; never send it.
        const expected = this.dry(() => (r.ok ? r.out.flatMap((o) => this.convert(o, b, e, e.at)) : [this.draft({ type: "policy.refused", by: "code:engine", data: {} }, e.at)]))
          .filter((d) => !this.secondary(d))
          .map((d) => this.loggedShape(d))
          .sort();
        const logged = (derivedBy.get(`${e.id}|${b.policy.id}`) ?? []).filter((d) => !this.secondary(d)).map((d) => this.loggedShape(d)).sort();
        if (JSON.stringify(expected) !== JSON.stringify(logged)) this.replayDiffs.push({ event: e.id, policy: b.policy.id, expected, logged });
      }
    }
  }

  // Events a single out item adds besides its main one (the packet of an
  // action card, the prepare command of an open): left out of the diff.
  private secondary(d: Event): boolean {
    return d.data?.secondary === true;
  }

  // Runs f with throwaway ids, so a replay comparison takes no real ids.
  private dry<T>(f: () => T): T {
    const real = this.ids;
    let n = 0;
    this.ids = { next: (prefix) => `${prefix}_dry${n++}` };
    try {
      return f();
    } finally {
      this.ids = real;
    }
  }

  private loggedShape(d: Event): string {
    switch (d.type) {
      case "command.issued":
        return d.data.reissue ? `issue|${d.data.type}|reissue` : `issue|${d.data.type}|${d.subject ?? ""}|${JSON.stringify(d.data.params ?? null)}`;
      case "card.opened":
        return `open|${d.subject ?? ""}`;
      case "card.withdrawn":
        return `withdraw|${d.card}`;
      case "command.cancelled":
        return `cancel|${d.command}`;
      case "clock.wake.requested":
        return `wake|${d.data.at}`;
      case "policy.refused":
        return "policy.refused";
      default:
        return `emit|${d.type}|${d.subject ?? ""}|${JSON.stringify(d.data ?? null)}`;
    }
  }

  // ---- projections --------------------------------------------------------

  private project(e: Event): void {
    if (e.key) this.keys.add(e.key);
    const d = e.data ?? {};
    switch (e.type) {
      case "card.opened":
        this.cards.set(e.card!, {
          id: e.card!, kind: d.kind, policy: d.policy, project: e.project ?? "", subject: e.subject, version: 0,
          state: d.kind === "action" ? "open" : "preparing", packet: null, prediction: null, predicted: false, shown: [],
          meta: d.meta, ...(d.command ? { command: d.command } : {}),
        });
        return;
      case "card.packet": {
        const c = this.cards.get(e.card!)!;
        c.version = d.version;
        c.packet = d.packet;
        c.meta = { ...c.meta, ...(d.meta ?? {}) };
        c.prediction = null;
        c.predicted = false;
        delete c.latePrediction;
        delete c.lateAfterDecide;
        delete c.decision;
        delete c.changedAfterPacket;
        delete c.reopened;
        if (c.kind === "decision" && c.state !== "withdrawn") c.state = "predicting";
        return;
      }
      case "card.predicted": {
        const c = this.cards.get(e.card!)!;
        if (d.version !== c.version) return;
        // A loop-kind card's answer after Nil's call: kept on the card, and the
        // Premove for his next call if he undoes this one.
        if (d.afterDecide) {
          c.latePrediction = d.prediction;
          c.lateAfterDecide = true;
          return;
        }
        // A late answer after Nil saw the stand-in is shown, not the Premove.
        if (d.late && d.seen) {
          c.latePrediction = d.prediction;
          return;
        }
        c.prediction = d.prediction ?? null;
        c.predicted = true;
        if (c.state === "predicting") c.state = "open";
        return;
      }
      case "card.decided": {
        const c = this.cards.get(e.card!)!;
        c.decision = { event: e.id, call: d.call, by: e.by, ...(d.generic ? { generic: d.generic } : {}), ...(d.option ? { option: d.option } : {}) };
        delete c.reopened;
        c.state = d.generic ? "preparing" : "decided";
        return;
      }
      // A rewrite or refine that brought no new packet: the card is open again
      // with its old packet, and the reason on it (Antifeed PM, 2026-10-31).
      case "card.reopened": {
        const c = this.cards.get(e.card!)!;
        delete c.decision;
        c.state = "open";
        c.reopened = String(d.reason ?? "");
        return;
      }
      case "card.undone": {
        const c = this.cards.get(e.card!)!;
        delete c.decision;
        c.state = "open";
        if (c.lateAfterDecide && c.latePrediction) {
          c.prediction = c.latePrediction;
          c.predicted = true;
          delete c.latePrediction;
        }
        delete c.lateAfterDecide;
        return;
      }
      case "card.withdrawn":
        this.cards.get(e.card!)!.state = "withdrawn";
        return;
      case "command.dropped": {
        const k = this.commands.get(e.command!);
        if (k) k.dropped = true;
        return;
      }
      // Nil's Done or Could not do it, held for an Undo (DESIGN.md 13.8).
      case "action.held": {
        const c = this.cards.get(e.card!)!;
        c.held = { event: e.id, ok: d.ok, note: d.note, until: d.until, member: e.member ?? "" };
        return;
      }
      case "action.released":
        delete this.cards.get(e.card!)!.held;
        return;
      case "command.issued": {
        this.commands.set(e.command!, {
          id: e.command!, type: d.type, policy: d.policy, project: e.project ?? "", actor: d.actor, subject: e.subject, card: d.card,
          params: d.params, causedBy: e.causedBy ?? "", delivery: d.delivery, burstMs: d.burstMs, timeoutMs: d.timeoutMs, state: "issued", issuedAt: e.at, ...(d.about ? { about: d.about } : {}), ...(d.reissue ? { reissueOf: d.reissue } : {}), ...(d.remake ? { remake: true } : {}),
        });
        if (d.reprepare && this.repreps.has(d.card)) this.repreps.get(d.card)!.command = e.command;
        const c = d.card && d.type !== PREDICT ? this.cards.get(d.card) : undefined;
        if (c && c.packet && (c.state === "open" || c.state === "predicting")) c.changedAfterPacket = true;
        return;
      }
      case "command.delivered":
      case "command.started":
      case "command.done":
      case "command.failed":
      case "command.cancelled": {
        const k = this.commands.get(e.command!)!;
        k.state = e.type.slice("command.".length) as CommandState;
        if (e.type === "command.delivered") k.deliveredAt = e.at;
        if (e.type === "command.started") {
          k.startedAt = e.at;
          if (Array.isArray(d.batch)) k.batch = d.batch;
        }
        if (e.type === "command.done" || e.type === "command.failed") k.doneAt = e.at;
        if (e.type === "command.done") k.result = d.result;
        if (e.type === "command.failed") {
          k.error = d.error;
          if (d.blocked) k.blocked = true;
          if (d.maybeSent) k.maybeSent = true;
          if (typeof d.detail === "string") k.detail = d.detail;
          // A predict the engine closed because its card has a newer version:
          // superseded, the normal path, not a failure to fix (Antifeed PM, 2026-10-30).
          if (e.by === "code:engine" && d.error === MOVED_ON) k.superseded = true;
        }
        if (e.type === "command.cancelled" && d?.reason) k.cancelReason = d.reason;
        const c = k.card ? this.cards.get(k.card) : undefined;
        if (c?.kind === "action" && (e.type === "command.done" || e.type === "command.failed")) c.state = "done";
        if (c?.held && TERMINAL.includes(k.state)) delete c.held;
        return;
      }
      case "cards.reprepare":
        for (const x of d.cards as { card: string; version: number }[]) this.repreps.set(x.card, { policy: d.policy, version: x.version, revise: d.revise });
        return;
      case "card.shown": {
        const c = this.cards.get(e.card!)!;
        if (!c.shown.includes(d.version)) c.shown.push(d.version);
        return;
      }
      // consult.* events of the slice 5 chat stay in old logs; the chat moved
      // to the office (DESIGN.md 13.1), so nothing reads them.
      case "chat.sent": {
        const t = this.threads.get(e.card!) ?? [];
        t.push({ id: e.id, card: e.card!, by: e.by, at: e.at, version: d.version, ...(d.text !== undefined ? { text: d.text } : { blob: d.blob }), replyId: d.replyId, state: "sending" });
        this.threads.set(e.card!, t);
        return;
      }
      case "chat.delivered":
      case "chat.failed": {
        const m = this.chatMsg(e.card!, d.msg);
        if (m && m.state !== "answered") {
          m.state = e.type === "chat.delivered" ? "sent" : d.maybe ? "maybe" : "failed";
          if (e.type === "chat.failed") m.error = d.error;
        }
        return;
      }
      case "input.sent":
        this.inputs.set(e.id, { id: e.id, at: e.at, target: d.target, page: d.page, ...(d.card ? { card: d.card } : {}), ...(d.images ? { images: d.images } : {}), ...(d.text !== undefined ? { text: d.text } : { blob: d.blob }), state: "sending" });
        return;
      case "input.filed": {
        const r = this.inputs.get(d.input);
        if (r) Object.assign(r, { state: "filed", taskId: d.task });
        return;
      }
      case "input.tell": {
        const r = this.inputs.get(d.input);
        if (r) Object.assign(r, { state: "filed", error: undefined });
        return;
      }
      case "input.told": {
        const r = this.inputs.get(d.input);
        if (r) Object.assign(r, { state: "told", error: undefined });
        return;
      }
      case "input.failed": {
        const r = this.inputs.get(d.input);
        // A failure after the task is filed is the PM's message only.
        if (r) Object.assign(r, { state: r.taskId ? "untold" : d.maybe ? "maybe" : "failed", error: d.error, detail: d.detail });
        return;
      }
      case "chat.answered": {
        const t = this.threads.get(e.card!) ?? [];
        const asked = t.find((x) => x.id === d.msg);
        if (asked) asked.state = "answered";
        t.push({ id: e.id, card: e.card!, by: e.by, at: e.at, version: d.version, ...(d.text !== undefined ? { text: d.text } : { blob: d.blob }), replyTo: d.msg });
        this.threads.set(e.card!, t);
        return;
      }
      case "clock.wake.requested":
        this.wakes.set(d.wake, { id: d.wake, policy: d.policy, at: d.at });
        return;
      case "clock.tick":
        this.wakes.delete(d.wake);
        return;
      case "policy.decider.set":
        this.deciderSet.set(d.policy, { config: d.config, at: e.at, member: e.member });
        return;
    }
  }

  // Who receives an event: policies that subscribe to its type, and the
  // policy that owns its card, command or wake. A project's policy hears a
  // type only from its own project: two projects can read the same kind of
  // source (isomux and Wall Game both read a board, with the same event
  // types). The built-in policy hears every project.
  private subscribers(e: Event): Bound[] {
    const owner =
      e.type === "clock.tick" ? e.data?.policy
      : e.type.startsWith("card.") && e.card ? this.cards.get(e.card)?.policy
      : e.type.startsWith("command.") && e.command && this.commands.get(e.command)?.type !== PREDICT ? this.commands.get(e.command)?.policy
      : undefined;
    // A generic call (rewrite, refine) is the engine's to handle: the owner
    // never sees it as a call.
    const ownerGets = !(e.type === "card.decided" && e.data?.generic);
    return [...this.bound.values()].filter((b) => (b.policy.on.includes(e.type) && (b.builtin || b.def.project === e.project)) || (ownerGets && b.policy.id === owner));
  }

  // rewrite and refine: the engine asks the policy's author for a new packet
  // with the policy's prepare command, the card's last prepare params plus
  // {revise} or {refine}.
  // Slice 8 walk: Nil took back a failed-command card's call. Its reissues
  // that have not gone out are cancelled, as the owner of a call cancels
  // what its Undo takes back (the reissue's policy is the failed command's,
  // so the built-in policy cannot cancel it itself).
  private undoneRetries(e: Event, at: string): Event[] {
    if (e.type !== "card.undone" || this.cards.get(e.card!)?.policy !== "command-failed") return [];
    return [...this.commands.values()]
      .filter((k) => k.causedBy === e.data?.decision && k.reissueOf && k.state === "issued")
      .map((k) => this.draft({ type: "command.cancelled", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: { undone: true } }, at));
  }

  private genericPrepare(e: Event, at: string): Event[] {
    // Nil took the generic call back: cancel the engine's prepare if it is not delivered.
    if (e.type === "card.undone" && e.data?.generic) {
      const k = [...this.commands.values()].find((x) => x.causedBy === e.data.decision && x.card === e.card && x.state === "issued");
      return k ? [this.draft({ type: "command.cancelled", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: {} }, at)] : [];
    }
    if (e.type !== "card.decided" || !e.data?.generic) return [];
    const c = this.cards.get(e.card!)!;
    const b = this.bound.get(c.policy)!;
    const type = b.policy.prepare!;
    const decl = b.policy.commands[type];
    const last = [...this.commands.values()].filter((k) => k.card === c.id && k.type === type).at(-1);
    const g = e.data.generic as Generic;
    const extra = g.kind === "rewrite" ? { revise: e.data.call?.note ?? "" } : { refine: g.option };
    const params = { ...((last?.params as object) ?? {}), ...extra };
    const actor = b.def.actors.find((a) => a.id === decl.actor)!;
    return [this.draft({
      type: "command.issued", by: "code:engine", project: b.def.project, causedBy: e.id, command: this.ids.next("k"), subject: c.subject,
      data: { type, policy: c.policy, actor: decl.actor, actorKind: actor.kind, card: c.id, params, delivery: decl.delivery, burstMs: decl.burstMs, timeoutMs: decl.timeoutMs },
    }, at)];
  }

  // Nil decided the card (not generic), or the card was withdrawn: a prepare
  // of the policy for it that is not delivered has nothing left to prepare.
  private stalePrepares(e: Event, at: string): Event[] {
    if (!((e.type === "card.decided" && !e.data?.generic) || e.type === "card.withdrawn")) return [];
    const c = this.cards.get(e.card!)!;
    // Slice 7: a withdrawn action card takes its action (Nil's command) with it.
    if (c.kind === "action") {
      const k = e.type === "card.withdrawn" && c.command ? this.commands.get(c.command) : undefined;
      return k && k.state === "issued" ? [this.draft({ type: "command.cancelled", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: {} }, at)] : [];
    }
    const type = this.bound.get(c.policy)?.policy.prepare;
    if (!type) return [];
    return [...this.commands.values()]
      .filter((k) => k.card === c.id && k.type === type && k.state === "issued")
      .map((k) => this.draft({ type: "command.cancelled", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: {} }, at));
  }

  // A prepare done with no packet, so no card stays in preparing (Antifeed PM,
  // 2026-10-31: five cards sat in preparing after Nil decided their tasks in
  // chat). A card with no packet yet leaves nothing to decide: it is withdrawn.
  // Nil's rewrite or refine (the prepare his generic call issued) brought
  // none: the card is open again with its old packet, so he can decide or ask
  // again. Either way with the reason in words (data.skipped).
  private emptyPrepare(e: Event, at: string): Event[] {
    const k = e.type === "command.done" && e.command ? this.commands.get(e.command) : undefined;
    const c = k?.card ? this.cards.get(k.card) : undefined;
    if (!k || !c || c.kind !== "decision" || c.state !== "preparing" || k.type !== this.bound.get(c.policy)?.policy.prepare) return [];
    const r = e.data?.result as { skipped?: unknown; card?: unknown } | null | undefined;
    // postPacket reports its prepare done after the packet: the card has moved on.
    if (r?.card) return [];
    const why = typeof r?.skipped === "string" && r.skipped.trim() ? r.skipped.trim().replace(/\.$/, "") : null;
    if (!c.packet) return [this.draft({ type: "card.withdrawn", by: "code:engine", project: c.project, causedBy: e.id, card: c.id, data: { reason: why ? `No packet: ${why}.` : "No packet: its author finished without one." } }, at)];
    if (!c.decision?.generic || k.causedBy !== c.decision.event) return [];
    const actor = this.actorOf(c.project, k.actor);
    const who = actor.kind === "agent" ? actor.agentName : "its author";
    return [this.draft({ type: "card.reopened", by: "code:engine", project: c.project, causedBy: e.id, card: c.id, data: { decision: c.decision.event, reason: `No new packet from ${who}: ${why ?? "it finished without one"}.` } }, at)];
  }

  // The consult predictor of a policy, through nil and threshold.
  consultConfig(policyId: string): Extract<DeciderConfig, { kind: "consult" }> | null {
    let c = this.effectiveDecider(policyId);
    while (c) {
      if (c.kind === "consult") return c;
      c = c.kind === "nil" ? (c.predictor ?? null) : c.kind === "threshold" ? c.agent : null;
    }
    return null;
  }

  private projectDef(project: string): ProjectDef | undefined {
    return [...this.bound.values()].find((b) => b.def.project === project)?.def;
  }

  consultActor(project: string): Actor | undefined {
    const def = this.projectDef(project);
    return def?.consult ? def.actors.find((a) => a.id === def.consult) : undefined;
  }

  // A predict for a card's new packet (DESIGN.md 13.1). When the card moves
  // on (a new packet, a decision, a withdrawal), its open predicts close:
  // cancelled if not started, failed with "card moved on" if started.
  private predictReaction(e: Event, at: string): Event[] {
    const c = e.card ? this.cards.get(e.card) : undefined;
    if (!c || c.kind !== "decision") return [];
    // A loop-kind card (Antifeed PM, 2026-10-30): a call keeps its predict
    // running, so the answer is logged after it; a rewrite or refine closes it.
    const loop = this.bound.get(c.policy)?.policy.cardKind === "loop";
    if (!(e.type === "card.packet" || (e.type === "card.decided" && !e.data?.generic !== loop) || e.type === "card.withdrawn")) return [];
    const out: Event[] = [];
    for (const k of this.commands.values()) {
      if (k.type !== PREDICT || k.card !== c.id || TERMINAL.includes(k.state)) continue;
      out.push(
        k.state === "started"
          ? this.draft({ type: "command.failed", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: { error: MOVED_ON } }, at)
          : this.draft({ type: "command.cancelled", by: "code:engine", project: k.project, causedBy: e.id, command: k.id, data: {} }, at),
      );
    }
    if (e.type !== "card.packet" || c.state !== "predicting") return out;
    const cfg = this.consultConfig(c.policy);
    const actor = this.consultActor(c.project);
    // No runtime: the stand-in runs at the next check.
    if (!cfg || !actor || !this.opts.predict) return out;
    out.push(this.draft(this.predictDraft(c, cfg.criteria, actor, e.id), at));
    return out;
  }

  // A predict command for the card's version, with its input as of now.
  private predictDraft(c: Card, criteria: string, actor: Actor, causedBy?: string, again: boolean | "remake" = false): EventDraft {
    const input = this.opts.predict!.input(c.policy, criteria, structuredClone(c), this.decisions.precedent(c.policy));
    const blob = this.opts.predict!.putBlob(input.text);
    return {
      type: "command.issued", by: "code:engine", project: c.project, ...(causedBy ? { causedBy } : {}), command: this.ids.next("k"), subject: c.subject,
      data: { type: PREDICT, policy: c.policy, actor: actor.id, actorKind: actor.kind, card: c.id, params: { card: c.id, version: c.version, input: blob, criteriaHash: input.criteriaHash, ...(input.pastCalls !== undefined ? { precedent: [], pastCalls: input.pastCalls } : { precedent: input.precedent }) }, delivery: "at-least-once", burstMs: 0, ...(again === "remake" ? { remake: true } : again ? { again: true } : {}) },
    };
  }

  private runReducer(b: Bound, e: Event): { ok: true; out: OutItem[] } | { ok: false; error: string } {
    try {
      const r = b.policy.reduce(this.states.get(b.policy.id), e);
      this.states.set(b.policy.id, r.state);
      return { ok: true, out: r.out ?? [] };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---- live ingest --------------------------------------------------------

  // One input: the head drafts plus the whole reaction, one write. Returns the
  // written events. Throws EngineError before anything is written.
  private ingest(head: EventDraft[]): Event[] {
    if (!head.length) return [];
    const at = new Date(this.now()).toISOString();
    const queue: Event[] = head.map((d) => this.draft(d, at));
    const all: Event[] = [...queue];
    try {
      while (queue.length) {
        const e = queue.shift()!;
        this.project(e);
        for (const m of [...this.genericPrepare(e, at), ...this.undoneRetries(e, at), ...this.stalePrepares(e, at), ...this.emptyPrepare(e, at), ...this.predictReaction(e, at)]) {
          all.push(m);
          queue.push(m);
        }
        for (const b of this.subscribers(e)) {
          const r = this.runReducer(b, e);
          const made = r.ok
            ? r.out.flatMap((o) => this.convert(o, b, e, at))
            : [this.draft({ type: "policy.refused", by: "code:engine", policy: b.policy.id, causedBy: e.id, data: { policy: b.policy.id, reason: `reduce threw: ${r.error}` } }, at)];
          for (const m of made) {
            all.push(m);
            queue.push(m);
          }
          if (all.length > MAX_DERIVED) throw new EngineError(500, `one input caused more than ${MAX_DERIVED} events; nothing was written`);
        }
      }
    } catch (err) {
      // Nothing was written: rebuild memory from the log.
      this.reset();
      throw err;
    }
    let written: Event[];
    try {
      written = this.log.append(all, at);
    } catch (err) {
      this.reset();
      throw err;
    }
    this.decisions.add(written, this.log.all());
    this.pump();
    if (written.some((e) => e.type === "command.issued")) this.opts.onIssued?.();
    return written;
  }

  // After a failed input: rebuild memory, and the replay differences, from the log.
  private reset(): void {
    this.replay();
  }

  private draft(d: EventDraft, at: string): Event {
    return { ...d, id: d.id ?? this.ids.next("e"), at, seq: 0, batch: "" } as Event;
  }

  private refused(b: Bound, e: Event, item: OutItem, reason: string, at: string): Event[] {
    return [this.draft({ type: "policy.refused", by: "code:engine", policy: b.policy.id, causedBy: e.id, data: { policy: b.policy.id, item, reason } }, at)];
  }

  private policyRef(b: Bound): ActorRef {
    return `code:${b.def.project}/${b.policy.id}`;
  }

  private withdrawable(cardId: string, b: Bound): boolean {
    const c = this.cards.get(cardId);
    // An action Nil marked waits out its Undo time and then goes out: it is not withdrawn (slice 7).
    return !!c && c.policy === b.policy.id && c.state !== "withdrawn" && c.state !== "decided" && c.state !== "done" && !c.held;
  }

  private cancellable(id: string, b: Bound): boolean {
    const k = this.commands.get(id);
    // An action Nil marked (held) goes out after its Undo time: a policy does not cancel it.
    const held = !!k?.card && !!this.cards.get(k.card)?.held;
    return !!k && k.policy === b.policy.id && k.state === "issued" && !held;
  }

  // The out check (DESIGN.md 2.1) and the events of each allowed item.
  private convert(o: OutItem, b: Bound, e: Event, at: string): Event[] {
    const p = b.policy;
    const base = { by: this.policyRef(b), project: b.def.project, causedBy: e.id, policy: p.id };
    if ("emit" in o) {
      const t = o.emit.type;
      if (isGeneric(t)) return this.refused(b, e, o, `"${t}" is a generic type; only the engine emits it`, at);
      if (!p.emits.includes(t)) return this.refused(b, e, o, `"${t}" is not in the policy's emits`, at);
      return [this.draft({ ...base, type: t, subject: o.emit.subject, data: o.emit.data ?? null }, at)];
    }
    if ("issue" in o) {
      const i = o.issue;
      if (i.card !== undefined && this.cards.get(i.card)?.policy !== p.id) return this.refused(b, e, o, `card ${i.card} is not this policy's`, at);
      const badAbout = i.about === undefined ? null : aboutError(i.about);
      if (badAbout) return this.refused(b, e, o, `about: ${badAbout}`, at);
      return this.issue(b, e, at, i.type, i.subject, i.card, i.params, i.packet, false, i.meta, i.about);
    }
    if ("repacket" in o) {
      const c = this.cards.get(o.repacket.card);
      // A code-made decision card too (a video's new render): its next packet version while Nil has not decided it.
      if (!c || c.policy !== p.id || (c.kind !== "action" && !(c.kind === "decision" && p.noAuthor))) return this.refused(b, e, o, `card ${o.repacket.card} is not an action card or a code-made card of this policy`, at);
      const bad = checkPacket(o.repacket.packet);
      if (bad) return this.refused(b, e, o, `packet: ${bad}`, at);
      // A card Nil marked (held), decided or that is gone stays as he saw it.
      if (c.kind === "action" ? c.state !== "open" || c.held : !(c.state === "open" || c.state === "predicting")) return [];
      return [this.draft({ ...base, type: "card.packet", card: c.id, data: { version: c.version + 1, packet: o.repacket.packet } }, at)];
    }
    if ("open" in o) {
      if (!p.decider) return this.refused(b, e, o, "a policy with no decider cannot open decision cards", at);
      const card = this.ids.next("c");
      const meta: CardMeta = { source: b.def.project, author: null, openedAt: at, raw: "", ...(o.open.meta ?? {}) };
      const out = [this.draft({ ...base, type: "card.opened", card, subject: o.open.subject, data: { kind: "decision", policy: p.id, meta } }, at)];
      if (o.open.packet) {
        const bad = checkPacket(o.open.packet);
        if (bad) return this.refused(b, e, o, `packet: ${bad}`, at);
        out.push(this.draft({ ...base, type: "card.packet", card, data: { version: 1, packet: o.open.packet, meta: { author: this.policyRef(b) }, secondary: true } }, at));
      }
      if (o.open.prepare) {
        const made = this.issue(b, e, at, o.open.prepare.type, o.open.subject, card, o.open.prepare.params, undefined, true);
        if (made[0]?.type === "policy.refused") return made;
        out.push(...made);
      }
      return out;
    }
    if ("withdraw" in o) {
      const c = this.cards.get(o.withdraw);
      if (!c || c.policy !== p.id) return this.refused(b, e, o, `card ${o.withdraw} is not this policy's`, at);
      if (o.reason !== undefined && (typeof o.reason !== "string" || o.reason.length > 500)) return this.refused(b, e, o, "reason must be a string of at most 500 characters", at);
      return this.withdrawable(o.withdraw, b) ? [this.draft({ ...base, type: "card.withdrawn", card: o.withdraw, data: o.reason ? { reason: o.reason } : {} }, at)] : [];
    }
    if ("cancel" in o) {
      const k = this.commands.get(o.cancel);
      if (!k || k.policy !== p.id) return this.refused(b, e, o, `command ${o.cancel} is not this policy's`, at);
      if (o.reason !== undefined && (typeof o.reason !== "string" || o.reason.length > 500)) return this.refused(b, e, o, "reason must be a string of at most 500 characters", at);
      return this.cancellable(o.cancel, b) ? [this.draft({ ...base, type: "command.cancelled", command: o.cancel, data: o.reason ? { reason: o.reason } : {} }, at)] : [];
    }
    if ("wakeAt" in o) {
      if (Number.isNaN(Date.parse(o.wakeAt))) return this.refused(b, e, o, "wakeAt is not a time", at);
      return [this.draft({ ...base, type: "clock.wake.requested", data: { policy: p.id, at: new Date(o.wakeAt).toISOString(), wake: this.ids.next("w") } }, at)];
    }
    if ("reissue" in o) {
      if (!b.builtin) return this.refused(b, e, o, "only the built-in command-failed policy may reissue", at);
      const k = this.commands.get(o.reissue.command);
      const owner = k && this.bound.get(k.policy);
      if (!k || !owner) return this.refused(b, e, o, `unknown command ${o.reissue.command}`, at);
      // Slice 8 walk: a failed command is sent again at most once (a retry
      // that an Undo cancelled does not count); a retry that fails again has its own card.
      if ([...this.commands.values()].some((x) => x.reissueOf === k.id && x.state !== "cancelled")) return this.refused(b, e, o, `command ${k.id} was already sent again`, at);
      const actor = o.reissue.actor ?? k.actor;
      const a = owner.def.actors.find((x) => x.id === actor);
      if (!a) return this.refused(b, e, o, `actor "${actor}" is not declared in ${owner.def.project}`, at);
      if (a.kind === "human") return this.refused(b, e, o, "a command is not reissued to a human", at);
      const decl = owner.policy.commands[k.type];
      return [this.draft({
        by: this.policyRef(b), project: owner.def.project, causedBy: e.id, policy: p.id, type: "command.issued", command: this.ids.next("k"), subject: k.subject,
        data: { type: k.type, policy: k.policy, actor, actorKind: a.kind, card: k.card, params: k.params, delivery: decl.delivery, burstMs: decl.burstMs, timeoutMs: decl.timeoutMs, ...(decl.notifyDrop ? { notifyDrop: true } : {}), reissue: k.id },
      }, at)];
    }
    if ("dropped" in o) {
      if (!b.builtin) return this.refused(b, e, o, "only the built-in command-failed policy may report a drop", at);
      const k = this.commands.get(o.dropped.command);
      if (!k || k.state !== "failed") return this.refused(b, e, o, `command ${o.dropped.command} is not failed`, at);
      return [this.draft({ by: this.policyRef(b), project: k.project, causedBy: e.id, policy: p.id, type: "command.dropped", command: k.id, data: {} }, at)];
    }
    return this.refused(b, e, o, "unknown out item", at);
  }

  private issue(b: Bound, e: Event, at: string, type: string, subject: string | undefined, card: string | undefined, params: unknown, packet?: Packet, secondary = false, meta?: Partial<CardMeta>, about?: CommandAbout): Event[] {
    const p = b.policy;
    const decl = p.commands[type];
    if (!decl) return this.refused(b, e, { issue: { type, params } }, `"${type}" is not in the policy's commands`, at);
    const actor = b.def.actors.find((a) => a.id === decl.actor)!;
    const base = { by: this.policyRef(b), project: b.def.project, causedBy: e.id, policy: p.id };
    const command = this.ids.next("k");
    const out: Event[] = [];
    let actionCard: string | undefined;
    if (actor.kind === "human") {
      // A command whose actor is Nil is an action card.
      const bad = packet ? checkPacket(packet) : "an action for a human needs a packet";
      if (bad) return this.refused(b, e, { issue: { type, params } }, bad, at);
      actionCard = this.ids.next("c");
    }
    out.push(this.draft({
      ...base, type: "command.issued", command, subject,
      data: { type, policy: p.id, actor: decl.actor, actorKind: actor.kind, card: card ?? actionCard, params: params ?? null, delivery: decl.delivery, burstMs: decl.burstMs, timeoutMs: decl.timeoutMs, ...(decl.notifyDrop ? { notifyDrop: true } : {}), ...(about ? { about } : {}), ...(secondary ? { secondary: true } : {}) },
    }, at));
    if (actionCard) {
      // Slice 7: the policy may name the card's source, raw link and filer (strings only); the author and the time are the engine's.
      const given: Partial<CardMeta> = {};
      for (const k of ["source", "raw", "createdBy", "priority", "effort"] as const) if (typeof meta?.[k] === "string") given[k] = meta[k];
      const cardMeta: CardMeta = { source: b.def.project, raw: "", ...given, author: this.policyRef(b), openedAt: at };
      out.push(this.draft({ ...base, type: "card.opened", card: actionCard, subject, data: { kind: "action", policy: p.id, command, meta: cardMeta, secondary: true } }, at));
      out.push(this.draft({ ...base, type: "card.packet", card: actionCard, data: { version: 1, packet, secondary: true } }, at));
    }
    return out;
  }

  // ---- deciders (live work) -----------------------------------------------

  effectiveDecider(policyId: string): DeciderConfig | null {
    const b = this.bound.get(policyId);
    if (!b?.policy.decider) return null;
    return this.deciderSet.get(policyId)?.config ?? startConfig(b.policy.decider);
  }

  // Starts a decider run for each card that waits for one: after each write,
  // and at start (a card left in `predicting` by a restart).
  private pump(): void {
    if (!this.live) return;
    for (const c of this.cards.values()) {
      if (c.state !== "predicting" || !this.cardOn(c)) continue;
      // The consult agent answers its predict command; checkPredicts runs the stand-in.
      if (this.consultConfig(c.policy)) continue;
      const key = `${c.id}@${c.version}`;
      if (this.running.has(key)) continue;
      this.running.add(key);
      const job = this.runDecider(c.id, c.version)
        // A write that fails here leaves the card in predicting; a restart runs it again.
        .catch((err) => console.error(`decider run for ${c.id} could not be written: ${(err as Error).message}`))
        .finally(() => {
        this.running.delete(key);
        this.jobs.delete(job);
      });
      this.jobs.add(job);
    }
  }

  // Waits for decider runs in flight (tests, shutdown).
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  private async runDecider(cardId: string, version: number): Promise<void> {
    const card = this.cards.get(cardId)!;
    const b = this.bound.get(card.policy)!;
    const config = this.effectiveDecider(card.policy)!;
    const handlers = b.def.handlers ?? {};
    let step: DeciderStep | null = null;
    let error: string | undefined;
    // The decider's id is logged on every card.predicted, a failed run too,
    // so the daily cap counts attempts.
    let deciderId = `config:${config.kind}`;
    try {
      const decider = build(config, card.policy, { ...this.opts.runtime, handlers });
      deciderId = decider.id;
      const timeout = this.opts.predictTimeoutMs ?? 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = new AbortController();
      try {
        step = await Promise.race([
          decider.decide(structuredClone(card), structuredClone(this.states.get(card.policy)), this.decisions.precedent(card.policy), stop.signal),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              // The run stops too (a claude -p process is killed).
              stop.abort();
              rej(new Error(`no answer in ${timeout} ms`));
            }, timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = (err as Error).message;
    }
    const now = this.cards.get(cardId);
    // The card moved on (a new packet, a withdrawal): this run is stale.
    if (!now || now.version !== version || now.state !== "predicting") return;
    // A decider's output is checked like Nil's call before it can reach a
    // command; one that fails is no prediction, and the card goes to Nil.
    let prediction = step?.prediction ? { ...step.prediction, call: snapToOptions(b.policy.answer ?? {}, step.prediction.call, now.packet) } : null;
    const bad = prediction ? this.checkPrediction(b.policy, prediction, now.packet) : step?.kind === "decided" ? "a decided step needs a prediction" : null;
    if (bad) {
      error = `prediction refused: ${bad}`;
      prediction = null;
      step = null;
    }
    // No Premove is not a state of a decision card (DESIGN.md 13.1): the code stand-in fills in.
    if (!prediction && now.kind === "decision") {
      prediction = this.codeStandin(b.policy, now, { reason: `${deciderId} gave no prediction`, ...(error ? { predictorError: error } : {}) });
      if (step?.kind === "decided") step = null;
    }
    const head: EventDraft[] = [{ type: "card.predicted", by: prediction?.by ?? "code:engine", project: card.project, card: cardId, data: { version, prediction, decider: deciderId, ...(error ? { error } : {}) } }];
    // Only the checked prediction decides; anything else in the step is ignored.
    if (step?.kind === "decided" && prediction && !prediction.standin)
      head.push({ type: "card.decided", by: prediction.by, project: card.project, card: cardId, data: { version, call: prediction.call, confidence: prediction.confidence, outcome: null, shownAt: null } });
    this.ingest(head);
  }

  // ---- the consult agent's predictions (live work, DESIGN.md 13.1) --------

  // The newest predict of a card version.
  private predictOf(cardId: string, version: number): CommandRec | undefined {
    return [...this.commands.values()].filter((k) => k.type === PREDICT && k.card === cardId && (k.params as { version?: number })?.version === version).at(-1);
  }

  // Run by the clock timer: a card whose consult agent did not start its
  // predict in startMs from its delivery, did not answer answerMs after the
  // start, or failed, gets the stand-in; so does one whose predict waited in
  // the dispatcher's queue for answerMs. At most STANDIN_AT_ONCE stand-ins
  // run at a time; a card over that waits for the next check.
  checkPredicts(now = this.now()): number {
    if (!this.live) return 0;
    const rt = this.opts.predict;
    let n = this.predictAgain();
    this.remakeForeign();
    this.reprepareStep();
    // A loop-kind card decided before its Premove keeps its predict (its answer
    // is logged); one its actor does not start in the usual waits is cancelled.
    if (rt)
      for (const k of [...this.commands.values()]) {
        if (k.type !== PREDICT || !k.card || !(k.state === "issued" || k.state === "delivered") || !this.commandOn(k)) continue;
        const c = this.cards.get(k.card);
        if (!c || c.state !== "decided" || this.bound.get(c.policy)?.policy.cardKind !== "loop") continue;
        if (k.state === "issued" ? now - Date.parse(k.issuedAt) >= rt.answerMs : now - Date.parse(k.deliveredAt ?? k.issuedAt) >= rt.startMs)
          this.ingest([{ type: "command.cancelled", by: "code:engine", project: k.project, command: k.id, data: { reason: "the card was decided before its Premove" } }]);
      }
    for (const c of this.cards.values()) {
      if (c.state !== "predicting" || !this.cardOn(c) || !this.consultConfig(c.policy)) continue;
      const key = `standin:${c.id}@${c.version}`;
      if (this.running.has(key)) continue;
      const k = this.predictOf(c.id, c.version);
      let reason: string | null = null;
      const who = this.consultActor(c.project);
      const name = who?.kind === "agent" ? who.agentName : "the consult agent";
      if (!who) reason = "this project has no consult agent";
      else if (!rt || !k) reason = `${name} got no request to predict this card`;
      else if (k.state === "issued") {
        if (now - Date.parse(k.issuedAt) >= rt.answerMs) reason = `${name} had other cards to predict first: this one waited ${rt.answerMs >= 60_000 ? `${Math.round(rt.answerMs / 60_000)} min` : `${Math.round(rt.answerMs / 1000)} s`}`;
      } else if (k.state === "delivered") {
        if (now - Date.parse(k.deliveredAt ?? k.issuedAt) >= rt.startMs) reason = `${name} was busy: it did not start within ${Math.round(rt.startMs / 1000)} s`;
      } else if (k.state === "started") {
        if (now - Date.parse(k.startedAt!) >= rt.answerMs) reason = `${name} started but gave no answer within ${Math.round(rt.answerMs / 1000)} s`;
      } else if (k.state === "failed") reason = `${name} failed: ${k.error ?? "no reason"}`;
      else if (k.state === "cancelled") reason = `${name}'s request was cancelled`;
      if (!reason) continue;
      if ([...this.running].filter((x) => x.startsWith("standin:")).length >= STANDIN_AT_ONCE) break;
      n++;
      // A predict not started yet is cancelled; a started one stays open for a late answer.
      if (k && (k.state === "issued" || k.state === "delivered")) this.ingest([{ type: "command.cancelled", by: "code:engine", project: k.project, command: k.id, data: { reason: "the stand-in runs" } }]);
      this.running.add(key);
      const job = this.runStandin(c.id, c.version, reason, k)
        .catch((err) => console.error(`stand-in for ${c.id} could not be written: ${(err as Error).message}`))
        .finally(() => {
          this.running.delete(key);
          this.jobs.delete(job);
        });
      this.jobs.add(job);
    }
    return n;
  }

  // A predict whose card waits for its Premove (predicting) goes before a
  // predict again, which no card waits for (the dispatcher's order).
  predictWaits(k: CommandRec): boolean {
    return !!k.card && this.cards.get(k.card)?.state === "predicting";
  }

  // Predict again (go-live burst, Antifeed PM, 2026-10-26): an open card
  // whose Premove is the code stand-in with no basis, and that Nil has not
  // seen, gets one more predict for its version, through the dispatcher's
  // queue. Its answer is the Premove while Nil has not seen the card (a late
  // answer); a card Nil decides meanwhile keeps his call (the predict closes).
  private predictAgain(now = this.now()): number {
    const rt = this.opts.predict;
    const drafts: EventDraft[] = [];
    // A predict for a card that already has its Premove (a predict again)
    // that its actor did not start in startMs from delivery closes: the card
    // keeps its stand-in. In the queue it waits with no limit: no card waits for it.
    for (const k of this.commands.values()) {
      const c = k.type === PREDICT && k.card ? this.cards.get(k.card) : undefined;
      if (!rt || !c || c.state === "predicting" || k.state !== "delivered" || !this.commandOn(k)) continue;
      if (now - Date.parse(k.deliveredAt ?? k.issuedAt) >= rt.startMs)
        drafts.push({ type: "command.cancelled", by: "code:engine", project: k.project, command: k.id, data: { reason: k.remake ? "not started in time; the card keeps its Premove" : "not started in time; the card keeps its stand-in" } });
    }
    for (const c of this.cards.values()) {
      const p = c.prediction;
      if (c.state !== "open" || c.kind !== "decision" || !rt || !p || p.by !== "code:standin" || p.standin?.basis !== "none" || c.shown.includes(c.version) || !this.cardOn(c)) continue;
      const cfg = this.consultConfig(c.policy);
      const actor = this.consultActor(c.project);
      if (!cfg || !actor) continue;
      const ks = [...this.commands.values()].filter((k) => k.type === PREDICT && k.card === c.id && (k.params as { version?: number })?.version === c.version);
      if (ks.length !== 1 || !TERMINAL.includes(ks[0].state)) continue;
      drafts.push(this.predictDraft(c, cfg.criteria, actor, undefined, true));
    }
    if (drafts.length) this.ingest(drafts);
    return drafts.length;
  }

  // Remake (Antifeed PM, 2026-10-29): an open card whose Premove an agent made
  // that is not its project's Predictor now (Wall Game cards predicted by
  // Isomux Consult before each project had its own) gets one new predict for
  // its version, from its project's Predictor, so the chat on the card goes to
  // the agent that made its Premove. Its answer replaces the Premove, also on a
  // card Nil has seen (the page marks it "updated"); a card Nil decides
  // meanwhile keeps his call. One at a time per card, at most REMAKE_TRIES per
  // card version (one its Predictor did not start in time is cancelled, and
  // the next check issues it again); the dispatcher paces them
  // (PREDICT_IN_FLIGHT). The clock runs it with checkPredicts.
  remakeForeign(): number {
    if (!this.opts.predict) return 0;
    const drafts: EventDraft[] = [];
    for (const c of this.cards.values()) {
      const m = c.state === "open" && c.kind === "decision" && !c.prediction?.standin && this.cardOn(c) ? /^agent:([^@]+)@/.exec(c.prediction?.by ?? "") : null;
      const cfg = m && this.consultConfig(c.policy);
      const actor = cfg && this.consultActor(c.project);
      if (!m || !cfg || actor?.kind !== "agent" || m[1] === actor.agentName || m[1] === "standin" || m[1] === "predictor") continue;
      const ks = [...this.commands.values()].filter((k) => k.type === PREDICT && k.card === c.id);
      if (ks.some((k) => !TERMINAL.includes(k.state))) continue;
      if (ks.filter((k) => k.remake && (k.params as { version?: number })?.version === c.version).length >= REMAKE_TRIES) continue;
      drafts.push(this.predictDraft(c, cfg.criteria, actor, undefined, "remake"));
    }
    if (drafts.length) this.ingest(drafts);
    return drafts.length;
  }

  // Re-prepare (Antifeed PM, 2026-10-29: the triage packet shape changed):
  // each open decision card of the policy gets one new packet from its
  // author, through the policy's prepare with the card's last params plus
  // {revise}. The request is one event; the clock (reprepareStep) issues the
  // prepares REPREPARE_AT_ONCE at a time. A card is done when its packet
  // version moved on, it is no longer open, or its prepare ended; it is
  // never asked twice for one packet version (a later re-prepare asks its new
  // version). A card with no earlier prepare (posted with no command) has no
  // params to send again: it is skipped. Returns the cards asked and skipped.
  reprepare(policyId: string, revise: string, by: ActorRef): { cards: string[]; skipped: string[] } {
    const b = this.bound.get(policyId);
    if (!b) throw new EngineError(404, `no policy ${policyId}`);
    if (!b.policy.prepare) throw new EngineError(400, `${policyId} has no prepare command: nobody writes its packets`);
    if (typeof revise !== "string" || !revise.trim() || revise.length > 4000) throw new EngineError(400, "revise must say what changed, in at most 4000 characters");
    const prepares = (c: Card) => [...this.commands.values()].filter((k) => k.card === c.id && k.type === b.policy.prepare);
    const open = [...this.cards.values()]
      .filter((c) => c.policy === policyId && c.kind === "decision" && (c.state === "open" || c.state === "predicting") && c.packet && this.repreps.get(c.id)?.version !== c.version)
      .filter((c) => !prepares(c).some((k) => !TERMINAL.includes(k.state)));
    const skipped = open.filter((c) => !prepares(c).length).map((c) => c.id);
    const cards = open.filter((c) => prepares(c).length).map((c) => ({ card: c.id, version: c.version }));
    if (cards.length) this.ingest([{ type: "cards.reprepare", by, project: b.def.project, data: { policy: policyId, revise: revise.trim(), cards } }]);
    this.reprepareStep();
    return { cards: cards.map((x) => x.card), skipped };
  }

  // The cards of a re-prepare not yet asked: open, at the version it asked about.
  reprepareLeft(): string[] {
    return [...this.repreps.entries()].filter(([id, r]) => !r.command && this.cards.get(id)?.version === r.version && ["open", "predicting"].includes(this.cards.get(id)!.state) && this.cardOn(this.cards.get(id)!)).map(([id]) => id);
  }

  reprepareStep(): number {
    const out = [...this.repreps.values()].filter((r) => r.command && !TERMINAL.includes(this.commands.get(r.command)!.state)).length;
    const next = this.reprepareLeft().slice(0, Math.max(0, REPREPARE_AT_ONCE - out));
    if (!next.length) return 0;
    this.ingest(next.map((id) => {
      const c = this.cards.get(id)!;
      const r = this.repreps.get(id)!;
      const b = this.bound.get(c.policy)!;
      const type = b.policy.prepare!;
      const decl = b.policy.commands[type];
      const last = [...this.commands.values()].filter((k) => k.card === c.id && k.type === type).at(-1);
      const { revise: _r, refine: _f, ...params } = (last?.params as Record<string, unknown>) ?? {};
      const actor = b.def.actors.find((a) => a.id === decl.actor)!;
      return {
        type: "command.issued", by: "code:engine", project: b.def.project, command: this.ids.next("k"), subject: c.subject,
        data: { type, policy: c.policy, actor: decl.actor, actorKind: actor.kind, card: c.id, params: { ...params, revise: r.revise }, delivery: decl.delivery, burstMs: decl.burstMs, timeoutMs: decl.timeoutMs, reprepare: true },
      } as EventDraft;
    }));
    return next.length;
  }

  // How many more predicts the dispatcher may hand to this actor now: up to
  // PREDICT_IN_FLIGHT delivered, or started less than answerMs ago (one
  // started longer ago stays open for a late answer, but holds no place).
  predictPlaces(project: string, actor: string, now = this.now()): number {
    const answerMs = this.opts.predict?.answerMs ?? Infinity;
    const busy = [...this.commands.values()].filter((k) => k.type === PREDICT && k.project === project && k.actor === actor && (k.state === "delivered" || (k.state === "started" && now - Date.parse(k.startedAt!) < answerMs))).length;
    return Math.max(0, PREDICT_IN_FLIGHT - busy);
  }

  // The claude -p stand-in with the same input, and the code vote if it fails.
  private async runStandin(cardId: string, version: number, reason: string, k: CommandRec | undefined): Promise<void> {
    const card = this.cards.get(cardId)!;
    const b = this.bound.get(card.policy)!;
    const rt = this.opts.predict;
    let params = (k?.params ?? {}) as { input?: string; precedent?: string[] };
    // The stand-in's own prompt, with the past calls' lines: the consult's input
    // names only their route (Nil, 2026-10-29). No predict went out (a project
    // with no consult agent): it is built here too.
    const cfg = this.consultConfig(card.policy);
    if (rt && cfg) {
      const input = rt.input(card.policy, cfg.criteria, structuredClone(card), this.decisions.precedent(card.policy));
      if (!params.input || input.standinText !== undefined) params = { input: rt.putBlob(input.standinText ?? input.text), precedent: input.precedent };
    }
    const text = rt && params.input ? rt.getBlob(params.input) : null;
    let prediction: Prediction | null = null;
    let predictorError: string | undefined;
    // No safe default: no quick model run, only the Predictor fills in a call.
    if (b.policy.noDefault) prediction = this.codeStandin(b.policy, card, { reason });
    else if (rt && text) {
      const stop = new AbortController();
      const timeout = this.opts.predictTimeoutMs ?? 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const p = await Promise.race([
          rt.standin(card.policy, text, stop.signal),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              stop.abort();
              rej(new Error(`no answer in ${timeout} ms`));
            }, timeout);
          }),
        ]);
        const full: Prediction = { ...p, call: snapToOptions(b.policy.answer ?? {}, p.call, card.packet), precedent: params.precedent ?? [], input: params.input, standin: { reason } };
        const bad = this.checkPrediction(b.policy, full, card.packet);
        if (bad) predictorError = `the quick model run's answer was refused: ${bad}`;
        else prediction = full;
      } catch (err) {
        predictorError = `the quick model run failed: ${(err as Error).message}`;
      } finally {
        clearTimeout(timer);
      }
    } else predictorError = "the quick model run had no input";
    if (!prediction) {
      prediction = this.codeStandin(b.policy, card, { reason, predictorError });
    }
    const now = this.cards.get(cardId);
    // The agent answered in the meantime, or the card moved on.
    if (!now || now.version !== version || now.state !== "predicting") return;
    this.ingest([{ type: "card.predicted", by: prediction.by, project: card.project, card: cardId, data: { version, prediction, decider: prediction.by } }]);
  }

  // The consult agent's answer to a started predict (an agent route). It is
  // the Premove if the card still waits for one; after a stand-in it is late:
  // the Premove only if Nil has not seen that version yet.
  predictionResult(id: string, body: unknown): Event[] {
    const k = this.agentCommand(id);
    if (k.type !== PREDICT) throw new EngineError(400, "this command asks for no prediction");
    if (k.state !== "started") throw new EngineError(409, k.state === "issued" || k.state === "delivered" ? "start the command first" : `the command is ${k.state}`);
    const params = k.params as { card: string; version: number; input: string; criteriaHash: string; precedent: string[]; pastCalls?: number };
    const c = this.cards.get(params.card);
    const loop = !!c && this.bound.get(c.policy)?.policy.cardKind === "loop";
    // A loop-kind card Nil decided before its Premove: the answer is logged on the card, not the Premove.
    const afterDecide = loop && c!.state === "decided" && !c!.decision?.generic;
    if (!c || c.version !== params.version || !(c.state === "predicting" || c.state === "open" || afterDecide)) throw new EngineError(409, "the card moved on");
    // A remake replaces the Premove of another project's Predictor (remakeForeign).
    const remake = !!k.remake && c.state === "open";
    // A loop-kind card back after an Undo with no Premove yet: the answer is its Premove.
    const late = afterDecide || (c.state === "open" && !remake && !(loop && !c.prediction));
    if (late && !afterDecide && !c.prediction?.standin) throw new EngineError(409, "the card already has its Premove");
    const b = this.bound.get(c.policy)!;
    const x = (body ?? {}) as { call?: Call; confidence?: number; why?: unknown; against?: unknown; informed?: unknown };
    const actor = this.actorOf(k.project, k.actor);
    const model = actor.kind === "agent" ? (this.opts.predict?.agentModel(actor.agentName) ?? "unknown") : "";
    const by: ActorRef = (actor.kind === "agent" ? `agent:${actor.agentName}@${model}#${params.criteriaHash}` : `code:${actor.kind === "code" ? actor.handler : actor.id}`);
    // A remake on a card Nil already saw: the Premove he saw (another
    // Predictor's) can shape his call, so calibration leaves it out (Antifeed
    // PM, 2026-10-29).
    const informed = x.informed === true || (c.version >= 2 && c.shown.some((v) => v < c.version)) || this.chatted(c.id) || (remake && c.shown.includes(c.version));
    const answer = this.opts.predict?.putBlob(JSON.stringify(body ?? null, null, 1));
    const prediction: Prediction = {
      call: snapToOptions(b.policy.answer ?? {}, x.call as Call, c.packet), confidence: x.confidence as number, why: String(x.why ?? ""), against: String(x.against ?? ""), by, precedent: params.precedent ?? [],
      ...(params.pastCalls !== undefined ? { pastCalls: params.pastCalls } : {}),
      input: params.input, ...(answer ? { answer } : {}), ...(informed ? { informed: true } : {}),
    };
    const bad = this.checkPrediction(b.policy, prediction, c.packet);
    if (bad) throw new EngineError(400, `prediction refused: ${bad}`);
    const seen = late && c.shown.includes(c.version);
    const head: EventDraft[] = [
      { type: "command.done", by, project: k.project, command: k.id, data: { result: { card: c.id, version: c.version } } },
      { type: "card.predicted", by, project: c.project, card: c.id, data: { version: c.version, prediction, decider: by, ...(late ? { late: true } : {}), ...(seen ? { seen: true } : {}), ...(afterDecide ? { afterDecide: true } : {}), ...(remake ? { remake: true } : {}) } },
    ];
    // Threshold decides only with the consult agent's own, on-time, not informed call (a remake is not on time).
    const cfg = this.effectiveDecider(c.policy);
    if (!late && !remake && !informed && actor.kind === "agent" && cfg?.kind === "threshold" && cfg.agent.kind === "consult" && prediction.confidence >= cfg.min)
      head.push({ type: "card.decided", by, project: c.project, card: c.id, data: { version: c.version, call: prediction.call, confidence: prediction.confidence, outcome: null, shownAt: null } });
    return this.ingest(head);
  }

  // The code stand-in's Premove. A call that fails the check (it should not:
  // each tier checks its own) is the policy's safe default. With no basis it
  // is the safe default as it is: an empty call for a policy with noDefault.
  private codeStandin(policy: Policy, card: Card, standin: { reason: string; predictorError?: string }): Prediction {
    const { basis, ...v } = codeVote(policy, card, this.decisions.precedent(card.policy));
    const p: Prediction = { ...v, standin: { ...standin, basis } };
    if (basis === "none" || !this.checkPrediction(policy, p, card.packet)) return p;
    const { basis: none, ...d } = safeDefault(policy);
    return { ...d, standin: { ...standin, basis: none } };
  }

  private checkPrediction(p: Policy, pr: { call: Call; confidence: number; by: unknown }, packet: Packet | null): string | null {
    if (typeof pr.confidence !== "number" || !Number.isFinite(pr.confidence) || pr.confidence < 0 || pr.confidence > 1) return `confidence ${String(pr.confidence)} is not in [0, 1]`;
    if (typeof pr.by !== "string" || !/^(agent|code):/.test(pr.by)) return "by must name an agent or code";
    if (!pr.call || typeof pr.call !== "object") return "call must be an object";
    return checkCall(p.answer ?? {}, pr.call, undefined, packet) ?? p.validate?.(pr.call, packet) ?? null;
  }

  // ---- the clock (live work) ----------------------------------------------

  dueWakes(now = this.now()): Wake[] {
    // An off policy's wake waits for its switch-on (a hold must not end unseen).
    return [...this.wakes.values()].filter((w) => Date.parse(w.at) <= now && this.isOn(w.policy)).sort((a, b) => a.at.localeCompare(b.at));
  }

  // Fires every due wake, one batch each. A wake missed in a downtime fires
  // late; the tick's `at` is the real time.
  fireWakes(now = this.now()): number {
    const due = this.dueWakes(now);
    for (const w of due) {
      // The failure policy's tick names the unfinished commands whose policy
      // is off (B4), so it opens no timeout card for them (Antifeed PM,
      // 2026-10-31). In the tick's data, so replay reads what it read then.
      const off = this.bound.get(w.policy)?.builtin ? [...this.commands.values()].filter((k) => !TERMINAL.includes(k.state) && !this.commandOn(k)).map((k) => k.id) : [];
      this.ingest([{ type: "clock.tick", by: "clock", data: { policy: w.policy, wake: w.id, due: w.at, ...(off.length ? { off } : {}) } }]);
    }
    return due.length;
  }

  // ---- human routes (the member check is the HTTP layer's, slice 3) -------

  private humanDraft(member: string, d: Omit<EventDraft, "by" | "member">): EventDraft {
    if (!member) throw new EngineError(403, "a human route needs the member id");
    return { ...d, by: this.human, member };
  }

  decide(member: string, cardId: string, input: { version: number; call: Call; generic?: Generic; shownAt?: string; option?: string }): Event[] {
    const c = this.cards.get(cardId);
    if (!c) throw new EngineError(404, "unknown packet");
    if (c.kind !== "decision") throw new EngineError(400, "an action is done or failed, not decided");
    this.onCard(c);
    const b = this.bound.get(c.policy)!;
    // A loop-kind card is open while its Premove is made (its page shows the pick).
    if (c.state !== "open" && !(c.state === "predicting" && b.policy.cardKind === "loop")) throw new EngineError(409, `the packet is ${c.state}, not open`);
    if (input.version !== c.version) throw new EngineError(409, `the packet is at version ${c.version}; you saw ${input.version}`);
    if (input.generic && !b.policy.prepare) throw new EngineError(400, "this policy takes no rewrite or refine: it names no prepare command");
    const bad = checkCall(b.policy.answer ?? {}, input.call, input.generic, c.packet) ?? (input.generic ? null : (b.policy.validate?.(input.call, c.packet) ?? null));
    if (bad) throw new EngineError(400, bad);
    if (input.option !== undefined && (input.generic || !(c.packet?.options ?? []).some((x) => x.id === input.option))) throw new EngineError(400, "option must name an option of the packet, with no rewrite or refine");
    const o = outcome(c.prediction, input.call, input.generic, b.policy.answer ?? {}, b.policy.primary ?? [], c.packet, b.policy.derived, input.option, b.policy.cardKind === "loop" ? (b.policy.loopCompare ?? ["choice", "priority"]) : undefined);
    return this.ingest([this.humanDraft(member, {
      type: "card.decided", project: c.project, card: cardId,
      data: { version: c.version, call: input.call, ...(input.generic ? { generic: input.generic } : {}), ...(input.option !== undefined ? { option: input.option } : {}), outcome: o, shownAt: input.shownAt ?? null },
    })]);
  }

  // Undo puts the card back in the queue. The owning policy hears card.undone
  // and cancels what was not delivered yet. A card an agent decided comes
  // back with the agent's call as its prediction, so Nil's next call is
  // counted against it.
  undo(member: string, cardId: string): Event[] {
    const c = this.cards.get(cardId);
    if (c) this.onCard(c);
    // An action card: Undo only while its result is held; after that it is sent.
    if (c?.kind === "action") {
      if (!c.held) throw new EngineError(409, c.state === "done" ? "the action was sent after its Undo time: it cannot be undone" : "nothing to undo");
      return this.ingest([this.humanDraft(member, { type: "action.released", project: c.project, card: cardId, data: { held: c.held.event } })]);
    }
    if (!c?.decision) throw new EngineError(409, "nothing to undo");
    // Slice 7: a policy whose call cannot be taken back refuses the Undo once a command of the call went out.
    const words = this.bound.get(c.policy)?.policy.undoUntilSent;
    if (words && this.sentOf(c).length) throw new EngineError(409, words);
    // Slice 8 walk 2: a drop freed what its commands held (a task, which may
    // have a new card already), so the drop cannot be taken back either.
    // Part J: the outside write of the call can no longer be taken back.
    const b = this.bound.get(c.policy);
    const refused = b?.policy.undoRefusal?.(this.states.get(c.policy), c, this.now()) ?? null;
    if (refused) throw new EngineError(409, refused);
    const freed = this.freedOf(c).length;
    if (freed) throw new EngineError(409, `Your drop freed ${freed > 1 ? "their tasks" : "its task"} already; it cannot be taken back.`);
    return this.ingest([this.humanDraft(member, { type: "card.undone", project: c.project, card: cardId, data: { decision: c.decision.event, version: c.version, ...(c.decision.generic ? { generic: true } : {}) } })]);
  }

  // The failed commands that Nil's drop on this failed-command card freed
  // (notifyDrop): the card's command, or every command of its batch. A drop
  // that an Undo took back never happened, so a dropped one is the call's.
  freedOf(c: Card): CommandRec[] {
    const lead = c.decision && c.subject?.startsWith("command:") ? c.subject.slice("command:".length) : null;
    return lead ? [...this.commands.values()].filter((k) => k.dropped && (k.id === lead || k.batch?.[0] === lead)) : [];
  }

  // Walk 2: a drop on this failed-command card that waits for its Undo time:
  // when it frees its commands, and how many; null for any other card.
  dropOf(c: Card): { at: string; commands: string[] } | null {
    const s = this.states.get(commandFailed.id) as { drops?: Record<string, { at: string; commands: string[] }> } | undefined;
    return s?.drops?.[c.id] ?? null;
  }

  // The commands that Nil's call on this card caused and that went out
  // (delivered, started or finished; not issued or cancelled).
  sentOf(c: Card): CommandRec[] {
    return this.callsOf(c).filter((k) => k.state !== "issued" && k.state !== "cancelled");
  }

  // What Nil's call on this card started, in order: its commands for this
  // card, the reissues a failed-command card's call made, and each one's
  // reissues after it (slice 8 walk). The last of a chain is where it stands.
  callsOf(c: Card): CommandRec[] {
    if (!c.decision) return [];
    const all = [...this.commands.values()];
    const chain = (k: CommandRec): CommandRec[] => [k, ...all.filter((x) => x.reissueOf === k.id).flatMap(chain)];
    return all.filter((k) => k.causedBy === c.decision!.event && (k.card === c.id || k.reissueOf)).flatMap(chain);
  }

  // Nil could see the card's Premove (DESIGN.md 13.1): once per version.
  cardShown(member: string, cardId: string, version: number): Event[] {
    if (!member) throw new EngineError(403, "a human route needs the member id");
    const c = this.cards.get(cardId);
    if (!c || c.kind !== "decision") throw new EngineError(404, "unknown packet");
    this.onCard(c);
    if (version !== c.version || c.shown.includes(version)) return [];
    return this.ingest([this.humanDraft(member, { type: "card.shown", project: c.project, card: cardId, data: { version } })]);
  }

  // ---- the chat on a card with its consult (round q1, H1) ------------------

  private chatMsg(cardId: string, msgId: string): ChatMsg | undefined {
    return this.threads.get(cardId)?.find((m) => m.id === msgId);
  }

  // The text of a chat message, from the log or its blob.
  chatText(m: ChatMsg): string {
    return m.text ?? (m.blob && this.opts.predict ? this.opts.predict.getBlob(m.blob) ?? "" : "");
  }

  private chatBody(text: string): { text: string } | { blob: string } {
    return text.length > CHAT_INLINE && this.opts.predict ? { blob: this.opts.predict.putBlob(text) } : { text };
  }

  // Nil's words to the card's consult. The HTTP layer sends them to the
  // office (chatOutcome logs how that went). The reply id goes only into that
  // office message: the consult answers with it, once.
  chatSend(member: string, cardId: string, text: unknown): Event {
    const c = this.cards.get(cardId);
    if (!c) throw new EngineError(404, "unknown packet");
    this.onCard(c);
    if (!this.consultActor(c.project)) throw new EngineError(409, "no Predictor works on this packet's project, so there is nobody to chat with");
    if (typeof text !== "string" || !text.trim()) throw new EngineError(400, "write a message first");
    if (text.length > CHAT_MAX) throw new EngineError(400, `a message is at most ${CHAT_MAX} characters`);
    const [e] = this.ingest([this.humanDraft(member, { type: "chat.sent", project: c.project, card: cardId, data: { version: c.version, replyId: randomBytes(16).toString("hex"), ...this.chatBody(text) } })]);
    return e;
  }

  // How the office took a chat message: delivered, or failed (maybe: it may
  // have gone out; the office gave no answer in time). In-process only.
  chatOutcome(cardId: string, msgId: string, r: { ok: true } | { ok: false; error: string; maybe?: boolean }): void {
    const m = this.chatMsg(cardId, msgId);
    if (!m || m.state !== "sending") return;
    const c = this.cards.get(cardId)!;
    this.ingest([{ type: r.ok ? "chat.delivered" : "chat.failed", by: "code:chat", project: c.project, card: cardId, data: r.ok ? { msg: msgId } : { msg: msgId, error: r.error, ...(r.maybe ? { maybe: true } : {}) } }]);
  }

  // ---- Nil's input that becomes a task (round q1, I) ------------------------

  // His words for a target's board. The HTTP layer files the task and tells
  // the target's PM (InputSender), and inputOutcome logs how each went. The
  // page's clientId is the event's key: a double tap, or the same request
  // again, files once.
  inputSend(member: string, x: { text?: unknown; target?: unknown; page?: unknown; card?: unknown; clientId?: unknown; images?: unknown }): { event: Event; duplicate: boolean } {
    const { text, target, page, card, clientId, images } = x;
    if (typeof text !== "string" || !text.trim()) throw new EngineError(400, "write something first");
    if (text.length > INPUT_MAX) throw new EngineError(400, `an input is at most ${INPUT_MAX} characters`);
    if (typeof target !== "string" || !(this.opts.inputTargets ?? []).includes(target)) throw new EngineError(400, "pick where it goes");
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new EngineError(400, "clientId: 8 to 64 letters, digits, _ or -");
    if (card !== undefined && card !== null && (typeof card !== "string" || !this.cards.has(card))) throw new EngineError(400, "unknown packet");
    if (images !== undefined && (!Array.isArray(images) || images.length > INPUT_IMAGES_MAX || !images.every((b) => typeof b === "string" && INPUT_IMAGE.test(b))))
      throw new EngineError(400, `at most ${INPUT_IMAGES_MAX} screenshots, PNG, JPEG or WebP, each from POST /api/blobs`);
    const key = `input|${clientId}`;
    if (this.keys.has(key)) return { event: this.log.all().find((e) => e.key === key)!, duplicate: true };
    const [e] = this.ingest([this.humanDraft(member, { type: "input.sent", project: BUILTIN_PROJECT, key, data: { target, page: typeof page === "string" ? page.slice(0, 40) : "", ...(card ? { card } : {}), ...(Array.isArray(images) && images.length ? { images } : {}), ...this.chatBody(text) } })]);
    return { event: e, duplicate: false };
  }

  // Nil asks again for the PM's message of an input whose task is filed.
  inputTell(member: string, id: string): Event {
    const r = this.inputs.get(id);
    if (!r) throw new EngineError(404, "unknown input");
    if (r.state !== "untold") throw new EngineError(409, r.state === "told" ? "the PM was told already" : "this input has no message to send again");
    const [e] = this.ingest([this.humanDraft(member, { type: "input.tell", project: BUILTIN_PROJECT, data: { input: id } })]);
    return e;
  }

  // How the office took an input: the task filed (its id), the PM told, or a
  // failure (maybe: it may have gone out). In-process only.
  inputOutcome(id: string, r: { filed: string } | { told: true } | { error: string; maybe?: boolean; detail?: string }): void {
    const x = this.inputs.get(id);
    if (!x) return;
    const ok = "filed" in r ? x.state === "sending" : "told" in r ? x.state === "filed" : x.state === "sending" || x.state === "filed";
    if (!ok) return;
    const data = "filed" in r ? { input: id, task: r.filed } : "told" in r ? { input: id } : { input: id, error: r.error, ...(r.maybe ? { maybe: true } : {}), ...(r.detail ? { detail: r.detail } : {}) };
    this.ingest([{ type: "filed" in r ? "input.filed" : "told" in r ? "input.told" : "input.failed", by: "code:input", project: BUILTIN_PROJECT, data }]);
  }

  // The text of an input, from the log or its blob.
  inputText(r: InputRec): string {
    return r.text ?? (r.blob && this.opts.predict ? this.opts.predict.getBlob(r.blob) ?? "" : "");
  }

  // At start, after the replay: an input still on its way lost its send to a
  // stop of the app. Before its task: it may have been filed. After it: the
  // PM was not told, with Tell again. In-process only.
  inputRestarted(): number {
    let n = 0;
    for (const r of this.inputs.values())
      if (r.state === "sending" || r.state === "filed") {
        this.inputOutcome(r.id, { error: r.state === "sending" ? "the app restarted while it filed this" : "the app restarted before it told the PM", maybe: true });
        n++;
      }
    return n;
  }

  // At start, after the replay (Antifeed Reviewer, B1): a message still
  // "sending" lost its send to a stop or a crash of the app. It may have gone
  // out, so it shows as "maybe", with Send again; its reply id still takes
  // the consult's answer. In-process only: the app runs it before it serves.
  chatRestarted(): number {
    let n = 0;
    for (const [cardId, t] of this.threads)
      for (const m of t)
        if (m.state === "sending" && this.cards.has(cardId)) {
          this.chatOutcome(cardId, m.id, { ok: false, error: "the app restarted while it sent this", maybe: true });
          n++;
        }
    return n;
  }

  // The consult's answer. The reply id binds it to one message the app sent
  // to this card's consult; the sender is that consult, never the body's word.
  chatReply(cardId: string, replyId: string, text: unknown): Event {
    const c = this.cards.get(cardId);
    const m = c && this.threads.get(cardId)?.find((x) => x.replyId === replyId && x.by === this.human);
    if (!c || !m) throw new EngineError(409, "no message of Nil's on this card has that reply id");
    if (m.state === "answered") throw new EngineError(409, "this message has its answer already");
    // "sending": the consult can answer before the office's send call returns.
    if (m.state === "failed") throw new EngineError(409, "this message did not go out to the consult");
    if (typeof text !== "string" || !text.trim()) throw new EngineError(400, "the answer has no text");
    if (text.length > CHAT_REPLY_MAX) throw new EngineError(400, `an answer is at most ${CHAT_REPLY_MAX} characters`);
    const a = this.consultActor(c.project);
    if (!a || a.kind === "human") throw new EngineError(409, "this card's project has no consult agent");
    const by: ActorRef = a.kind === "agent" ? `agent:${a.agentName}` : `code:${a.handler}`;
    const [e] = this.ingest([{ type: "chat.answered", by, project: c.project, card: cardId, data: { msg: m.id, version: c.version, ...this.chatBody(text) } }]);
    return e;
  }

  // Nil wrote in this card's chat: a Premove made after it carries his view.
  // A message that failed and never reached the consult counts too: that only
  // takes a Premove out of the accuracy, which is the safe side.
  private chatted(cardId: string): boolean {
    return !!this.threads.get(cardId)?.some((m) => m.by === this.human);
  }

  // Precedent from before Antifeed (the loop app's triage calls), once per
  // policy and source. In-process only: the app runs it at start.
  importPrecedent(policyId: string, source: string, lines: DecisionLine[]): { events: Event[]; duplicate: boolean } {
    const b = this.bound.get(policyId);
    if (!b?.policy.decider) throw new EngineError(404, "unknown policy, or a policy with no decider");
    const key = `precedent.import|${policyId}|${source}`;
    if (this.keys.has(key)) return { events: [], duplicate: true };
    if (lines.some((l) => l.policy !== policyId || !l.imported || !l.id.startsWith("d_"))) throw new EngineError(400, "each line must be an imported line of this policy");
    return { events: this.ingest([{ type: "precedent.imported", by: "code:engine", project: b.def.project, key, data: { policy: policyId, source, lines } }]), duplicate: false };
  }

  setDecider(member: string, policyId: string, config: DeciderConfig): Event[] {
    const b = this.bound.get(policyId);
    if (!b?.policy.decider) throw new EngineError(404, "unknown policy, or a policy with no decider");
    const why = allowedSwitch(b.policy.decider, b.policy.autoAllowed === true, config);
    if (why) throw new EngineError(400, why);
    return this.ingest([this.humanDraft(member, { type: "policy.decider.set", project: b.def.project, data: { policy: policyId, config } })]);
  }

  // Done or Could not do it is held for actionUndoMs, so an Undo is real and
  // no page has to stay open (DESIGN.md 13.8). finishHeld sends it after.
  completeAction(member: string, cardId: string, input: { ok: boolean; note?: string }): Event[] {
    const c = this.cards.get(cardId);
    if (!c || c.kind !== "action" || !c.command) throw new EngineError(404, "unknown action");
    this.onCard(c);
    const k = this.commands.get(c.command)!;
    if (TERMINAL.includes(k.state)) throw new EngineError(409, `the action is already ${k.state}`);
    if (c.held) throw new EngineError(409, "the action is already marked; Undo it first");
    const until = new Date(this.now() + (this.opts.actionUndoMs ?? ACTION_UNDO_MS)).toISOString();
    return this.ingest([this.humanDraft(member, { type: "action.held", project: c.project, card: cardId, data: { command: k.id, ok: input.ok, note: input.note ?? "", until } })]);
  }

  // Run by a timer: each held action whose Undo time ended is sent as Nil's
  // result, as the member who marked it.
  finishHeld(now = this.now()): number {
    let n = 0;
    for (const c of [...this.cards.values()]) {
      const h = c.held;
      if (!h || Date.parse(h.until) > now || !c.command || !this.cardOn(c)) continue;
      const k = this.commands.get(c.command)!;
      this.ingest([this.humanDraft(h.member, {
        type: h.ok ? "command.done" : "command.failed", project: c.project, command: k.id, causedBy: h.event,
        data: h.ok ? { result: { note: h.note } } : { error: h.note || "failed" },
      })]);
      n++;
    }
    return n;
  }

  // ---- agent routes -------------------------------------------------------

  private actorOf(project: string, actorId: string): Actor {
    const def = [...this.bound.values()].find((b) => b.def.project === project)?.def;
    const a = def?.actors.find((x) => x.id === actorId);
    if (!a) throw new EngineError(403, `"${actorId}" is not an actor of ${project}`);
    if (a.kind === "human") throw new EngineError(403, "an agent route never writes as a human");
    return a;
  }

  private ref(a: Actor): ActorRef {
    return a.kind === "agent" ? `agent:${a.agentName}` : `code:${a.id}`;
  }

  private agentCommand(id: string): CommandRec {
    const k = this.commands.get(id);
    if (!k) throw new EngineError(404, "unknown command");
    if (!this.commandOn(k)) throw new EngineError(409, "this policy is off");
    this.actorOf(k.project, k.actor);
    return k;
  }

  // The dispatcher's own failure report: a command it will not send (stale
  // after a restart) or a code actor that threw. command-failed opens a card.
  dispatchFailed(id: string, error: string): Event[] {
    const k = this.agentCommand(id);
    if (TERMINAL.includes(k.state)) return [];
    return this.ingest([{ type: "command.failed", by: "code:dispatcher", project: k.project, command: id, data: { error } }]);
  }

  // The actor a command goes to, as its project declares it.
  actorFor(k: CommandRec): Actor | undefined {
    return [...this.bound.values()].find((b) => b.def.project === k.project)?.def.actors.find((a) => a.id === k.actor);
  }

  runner(project: string, name: string): ((command: CommandRec, ctx: RunContext) => unknown) | undefined {
    return [...this.bound.values()].find((b) => b.def.project === project)?.def.run?.[name];
  }
  batchRunner(project: string, name: string): ((commands: CommandRec[], ctx: RunContext) => Promise<unknown[]>) | undefined {
    return [...this.bound.values()].find((b) => b.def.project === project)?.def.runBatch?.[name];
  }

  // Every bound policy with its project, the built-in one included (the page and the flow view).
  policies(): { policy: Policy; project: string; builtin: boolean }[] {
    return [...this.bound.values()].map((b) => ({ policy: b.policy, project: b.def.project, builtin: b.builtin }));
  }

  projects(): ProjectDef[] {
    return [...new Set([...this.bound.values()].filter((b) => !b.builtin).map((b) => b.def))];
  }

  // The dispatcher reports a delivery.
  delivered(id: string): Event[] {
    const k = this.agentCommand(id);
    if (k.state !== "issued") return [];
    return this.ingest([{ type: "command.delivered", by: "code:dispatcher", project: k.project, command: id, data: {} }]);
  }

  // Before any command runs: a cancelled, finished or started command is
  // refused, so an Undo during the send and a second delivery never run.
  // batch: the commands of one batch run, so a failure gives one card for them all.
  startCommand(id: string, batch?: string[]): Event[] {
    const k = this.agentCommand(id);
    if (k.state === "started" || TERMINAL.includes(k.state)) throw new EngineError(409, `the command is already ${k.state}`);
    return this.ingest([{ type: "command.started", by: this.ref(this.actorOf(k.project, k.actor)), project: k.project, command: id, data: batch ? { batch } : {} }]);
  }

  // A repeat result for a finished command is dropped (duplicate: true).
  // blocked: the failure holds until someone fixes its cause (a switch that
  // is off), so a retry now fails the same way (slice 7). maybeSent: the
  // send may have gone out, so a retry may send it twice (slice 8).
  commandResult(id: string, input: { ok: boolean; data?: unknown; error?: string; detail?: string; blocked?: boolean; maybeSent?: boolean }): { events: Event[]; duplicate: boolean } {
    const k = this.agentCommand(id);
    if (TERMINAL.includes(k.state)) return { events: [], duplicate: true };
    const by = this.ref(this.actorOf(k.project, k.actor));
    const d = input.ok ? { result: input.data ?? null } : { error: input.error || "failed", ...(input.blocked ? { blocked: true } : {}), ...(input.maybeSent ? { maybeSent: true } : {}), ...(input.detail ? { detail: input.detail } : {}) };
    return { events: this.ingest([{ type: input.ok ? "command.done" : "command.failed", by, project: k.project, command: id, data: d }]), duplicate: false };
  }

  // A packet. With a command: the answer to that prepare command, which it
  // reports done. Without: an unsolicited card from a declared author.
  postPacket(input: { command?: string; policy?: string; actor?: string; subject?: string; packet: Packet; meta: Partial<CardMeta> & { raw: string } }): Event[] {
    const bad = checkPacket(input.packet) ?? checkAgentQuestion(input.packet) ?? (typeof input.meta?.raw === "string" && input.meta.raw ? null : "meta.raw is required: a link to the source as it came");
    if (bad) throw new EngineError(400, bad);
    if (input.command) {
      const k = this.agentCommand(input.command);
      if (TERMINAL.includes(k.state)) throw new EngineError(409, `the command is already ${k.state}`);
      const c = k.card ? this.cards.get(k.card) : undefined;
      if (!c || c.kind !== "decision") throw new EngineError(400, "this command asks for no packet");
      if (c.state === "withdrawn" || c.state === "decided") throw new EngineError(409, `the card is ${c.state}`);
      this.plainWords(c.policy, input.packet, input.meta);
      const by = this.ref(this.actorOf(k.project, k.actor));
      return this.ingest([
        { type: "card.packet", by, project: k.project, card: c.id, data: { version: c.version + 1, packet: input.packet, meta: { ...input.meta, author: by } } },
        { type: "command.done", by, project: k.project, command: k.id, data: { result: { card: c.id, version: c.version + 1 } } },
      ]);
    }
    const b = input.policy ? this.bound.get(input.policy) : undefined;
    if (!b || b.builtin) throw new EngineError(404, "unknown policy");
    const authors = b.policy.author === undefined ? [] : Array.isArray(b.policy.author) ? b.policy.author : [b.policy.author];
    if (!input.actor || !authors.includes(input.actor)) throw new EngineError(403, `"${input.actor ?? ""}" is not an author of ${b.policy.id}`);
    if (!b.policy.decider) throw new EngineError(400, "this policy has no decider");
    this.plainWords(b.policy.id, input.packet, input.meta);
    const by = this.ref(this.actorOf(b.def.project, input.actor));
    // Part G (Antifeed PM, 2026-10-30): the author's open card for this subject
    // takes the post as its new packet version, not a second card. The newest one.
    // A card with the author's prepare out is answered through that command only.
    const live = input.subject === undefined ? [] : [...this.cards.values()].filter((c) => c.kind === "decision" && c.policy === b.policy.id && c.subject === input.subject && OPEN.includes(c.state));
    const out = [...this.commands.values()].find((k) => k.type === b.policy.prepare && k.actor === input.actor && !TERMINAL.includes(k.state) && live.some((c) => c.id === k.card));
    if (out) throw new EngineError(409, `answer the open prepare ${out.id} with its command: {"command":"${out.id}","packet":...}`);
    const mine = live.filter((c) => c.meta.author === by).at(-1);
    if (mine) return this.ingest([{ type: "card.packet", by, project: b.def.project, card: mine.id, data: { version: mine.version + 1, packet: input.packet, meta: { ...input.meta, author: by } } }]);
    const at = new Date(this.now()).toISOString();
    const card = this.ids.next("c");
    const meta: CardMeta = { source: input.actor, openedAt: at, ...input.meta, author: by };
    return this.ingest([
      { type: "card.opened", by, project: b.def.project, card, subject: input.subject, data: { kind: "decision", policy: b.policy.id, meta } },
      { type: "card.packet", by, project: b.def.project, card, data: { version: 1, packet: input.packet, meta: {} } },
    ]);
  }

  // Part G: the card's author withdraws its open card, with a reason. The
  // policy reduces card.withdrawn as for its own withdraw.
  withdrawCard(cardId: string, input: { actor?: unknown; reason?: unknown }): Event[] {
    const c = this.cards.get(cardId);
    if (!c) throw new EngineError(404, "unknown card");
    this.onCard(c);
    if (typeof input.actor !== "string" || !input.actor) throw new EngineError(400, "actor is required: the card's author");
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new EngineError(400, "reason is required");
    const by = this.ref(this.actorOf(c.project, input.actor));
    if (c.kind !== "decision" || c.meta.author !== by) throw new EngineError(403, `"${input.actor}" is not this card's author`);
    if (!OPEN.includes(c.state)) throw new EngineError(409, `the card is ${c.state}, not open`);
    return this.ingest([{ type: "card.withdrawn", by, project: c.project, card: c.id, data: { reason: input.reason } }]);
  }

  private plainWords(policy: string, packet: Packet, meta: unknown): void {
    const p = this.bound.get(policy)?.policy;
    const bad = (p?.plainWords ? codeInPacket(packet, p.plainWords === "above-folds") : null) ?? p?.checkPacket?.(packet, (meta ?? {}) as Record<string, unknown>) ?? null;
    if (bad) throw new EngineError(400, bad);
    // A loop-kind packet is the packet creator's pick: an option named in
    // recommended (one option; a refine gives variants of it, one of them the pick).
    if (p?.cardKind === "loop" && (!packet.options?.length || !packet.recommended))
      throw new EngineError(400, "this card takes your pick as an option named in recommended: {options:[{id:\"pick\",label,fill:{choice,priority,title?,scope?}}],recommended:\"pick\"}");
    // Word caps (Antifeed PM, 2026-10-30): the loop card shows about 60 words.
    // The why is every block above the folds but an image; each option is a pick or its variant.
    if (p?.cardKind === "loop") {
      const words = (s: unknown) => (typeof s === "string" ? s.split(/\s+/).filter(Boolean).length : 0);
      // Every text the page shows as Why: a block's text, items, rows, label, caption.
      const shown = (x: Record<string, unknown>) => [x.text, x.label, x.caption, ...(Array.isArray(x.items) ? x.items : []), ...(Array.isArray(x.rows) ? x.rows.flat() : [])];
      // Part I: an image (its caption too) is not the why.
      const why = packet.blocks.filter((x) => x.type !== "fold" && x.type !== "image").reduce((n, x) => n + shown(x as Record<string, unknown>).reduce((m: number, t) => m + words(t), 0), 0);
      if (why > 60) throw new EngineError(400, `the why is ${why} words; the cap is 60. Lead with the answer in at most two short sentences`);
      // An image caption, in a fold too: at most 30 words (Antifeed PM, 2026-10-30).
      const caps = (bs: Packet["blocks"]): number[] => bs.flatMap((x) => (x.type === "image" ? [words(x.caption)] : x.type === "fold" ? caps(x.blocks) : []));
      const cap = Math.max(0, ...caps(packet.blocks));
      if (cap > 30) throw new EngineError(400, `an image caption is ${cap} words; the cap is 30. Name the part the red box shows`);
      for (const o of packet.options ?? []) {
        const n = words(o.fill?.scope);
        if (n > 100) throw new EngineError(400, `the scope of option "${o.id}" is ${n} words; the cap is 100. Give a scope only when the task's own text would send a worker the wrong way`);
      }
    }
  }

  // A fact from an agent or code actor (the HTTP route): only a type the
  // policies file lets that actor emit. A repeated key is dropped.
  reportEvent(input: { project: string; from: string; type: string; subject?: string; data?: unknown; key?: string }): { events: Event[]; duplicate: boolean } {
    return this.fact(input, false);
  }

  // A fact from a source inside the app (the board poller). Not an HTTP route.
  sourceEvent(input: { project: string; source: string; type: string; subject?: string; data?: unknown; key?: string }): { events: Event[]; duplicate: boolean } {
    return this.fact({ ...input, from: input.source }, true);
  }

  private fact(input: { project: string; from: string; type: string; subject?: string; data?: unknown; key?: string }, asSource: boolean): { events: Event[]; duplicate: boolean } {
    if (isGeneric(input.type)) throw new EngineError(403, `"${input.type}" is a generic type; only the engine emits it`);
    const def = [...this.bound.values()].find((b) => b.def.project === input.project)?.def;
    if (!def) throw new EngineError(404, "unknown project");
    const decl = def.events[input.type];
    const from = decl ? (Array.isArray(decl.from) ? decl.from : [decl.from]) : [];
    if (!from.includes(input.from)) throw new EngineError(403, `"${input.from}" may not emit "${input.type}"`);
    const source = def.sources?.find((s) => s.id === input.from);
    if (asSource !== !!source) throw new EngineError(403, asSource ? `"${input.from}" is not a source of ${input.project}` : `"${input.from}" is a source; only the app's own poller writes as a source`);
    const by: ActorRef = source ? `code:source/${source.id}` : this.ref(this.actorOf(input.project, input.from));
    const key = input.key ? `${input.project}|${input.from}|${input.key}` : undefined;
    if (key && this.keys.has(key)) return { events: [], duplicate: true };
    return { events: this.ingest([{ type: input.type, by, project: input.project, subject: input.subject, key, data: input.data ?? null }]), duplicate: false };
  }

  // Releases the data dir lock (shutdown).
  close(): void {
    this.unlock?.();
    this.unlock = null;
  }

  // ---- reads --------------------------------------------------------------

  state(policyId: string): unknown {
    return this.states.get(policyId);
  }

  // The failed commands that are a failure to fix (/api/status): not Nil's own
  // "Could not do it" on an action card, not one he dropped or that was sent
  // again (slice 7 and 8 walks), and not a superseded predict.
  failures(): CommandRec[] {
    const all = [...this.commands.values()];
    return all.filter((k) => k.state === "failed" && this.commandOn(k) && !k.superseded && !(k.card && this.cards.get(k.card)?.command === k.id) && !k.dropped && !all.some((x) => x.reissueOf === k.id && x.state !== "cancelled"));
  }

  queue(): Card[] {
    return [...this.cards.values()].filter((c) => c.state === "open" && this.cardOn(c));
  }

  // Part J, B4: a policy that is not loaded (its switch is off) keeps its log.
  // Its cards and commands are off, not gone: the view, the queue, the status
  // and the dispatcher leave them out, the clock does not run them, and a
  // write to them is refused. When the switch is on again, they come back.
  isOn(policyId: string): boolean {
    return this.bound.has(policyId);
  }

  commandOn(k: CommandRec): boolean {
    return this.isOn(k.policy);
  }

  // A failed-command card is off with the command it is about.
  cardOn(c: Card): boolean {
    if (!this.isOn(c.policy)) return false;
    const lead = c.subject?.startsWith("command:") ? this.commands.get(c.subject.slice("command:".length)) : undefined;
    return !lead || this.commandOn(lead);
  }

  // Nil, 2026-10-31 (DESIGN.md 22): the cards of policies that moved off
  // Antifeed (switched off, so not loaded) and still wait (preparing,
  // predicting or open) are withdrawn with the reason, and so are the open
  // failed-command cards about their commands. Once: a withdrawn card is not
  // asked again. The log keeps them (B4), readable with GET /api/cards?state=all.
  withdrawOff(policies: string[], reason: string): Event[] {
    const moved = (id: string) => policies.includes(id) && !this.isOn(id);
    const drafts: EventDraft[] = [];
    for (const c of this.cards.values()) {
      if (!OPEN.includes(c.state)) continue;
      const lead = c.subject?.startsWith("command:") ? this.commands.get(c.subject.slice("command:".length)) : undefined;
      if (moved(c.policy) || (lead && moved(lead.policy))) drafts.push({ type: "card.withdrawn", by: "code:engine", project: c.project, card: c.id, data: { reason } });
    }
    return drafts.length ? this.ingest(drafts) : [];
  }

  private onCard(c: Card): void {
    if (!this.cardOn(c)) throw new EngineError(409, "this policy is off");
  }

  deciderOf(policyId: string): { config: DeciderConfig | null; setAt: string | null } {
    return { config: this.effectiveDecider(policyId), setAt: this.deciderSet.get(policyId)?.at ?? null };
  }
}
