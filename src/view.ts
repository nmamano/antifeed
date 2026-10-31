// What the page shows, in one read (DESIGN.md 13.3): every tab renders from
// it, so a tab switch makes no request. Status is fetched on its own tab.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Blobs } from "./blobs";
import type { CommandRec, Engine } from "./engine";
import { BOARD_MS, CHAT_AGENT, DEMO, INBOX, INBOX_MS, MOVED_NOTE, OFFICE_URL } from "./config";
import { ASKS_OFF } from "./inbox";
import { INPUT_TARGETS, inputTitle } from "./input";
import { calibration, weekly } from "./metrics";
import type { Agent } from "./office";
import type { Block, Card, DeciderConfig, Policy } from "./types";

export const DECIDED_MAX = 200;

// One color per policy: its own, or a hash of its id into this palette, so a
// new policy moves no other color.
export const PALETTE = ["#2f6fde", "#7c3aed", "#0f8a6a", "#c2410c", "#b8336a", "#1d7fa6", "#8a6d00", "#5b5bd6"];
export function colorOf(p: Policy): string {
  if (p.color) return p.color;
  let h = 0;
  for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const nameOf = (p: Policy) => p.name ?? p.id.replace(/[-.]/g, " ").replace(/^./, (c) => c.toUpperCase());

export type AgentInfo = Agent & { live: boolean };

export type ViewOptions = {
  engine: Engine;
  // name -> the office's agent record, read at most every 30 s.
  agents: () => Map<string, Agent>;
  folderOf: (policy: string) => string | undefined;
  chatUrl: string;
  // Queue round 1 (S1): the sources whose last read failed, for one line at
  // the top of the queue that links to the Sources tab. Nil's Inbox access
  // (asks off) is a state, not a failure: only the Sources tab shows it.
  sourceAlerts?: () => SourceAlert[];
};
// A broken source: its timer's key ("board:wallgame/board", "inbox:inbox/inbox") and the read's error.
export type SourceAlert = { key: string; error: string };

function predictorOf(c: DeciderConfig | null): DeciderConfig | null {
  if (!c) return null;
  return c.kind === "nil" ? (c.predictor ?? null) : c.kind === "threshold" ? c.agent : c;
}

function agentOf(o: ViewOptions, name: string) {
  const a = o.agents().get(name);
  return a ? { name, live: true, id: a.id, model: a.model ?? null, effort: a.effort ?? null, room: a.roomName ?? null, busy: !!a.inFlightTurn } : { name, live: false };
}

// Round q1, H2: the live office agents by name, so the page links each
// name it shows to that agent's chat. Only the id and the room.
function roster(o: ViewOptions): Record<string, { id: string; room: string | null }> {
  return Object.fromEntries([...o.agents().values()].map((a) => [a.name, { id: a.id, room: a.roomName ?? null }]));
}

// Round q1, I: where Nil's input can go, and his last 20 inputs, newest first.
const INPUTS_SHOWN = 20;
function inputs(o: ViewOptions) {
  const e = o.engine;
  const list = [...e.inputs.values()].slice(-INPUTS_SHOWN).reverse();
  return {
    targets: INPUT_TARGETS.map((t) => ({ id: t.id, name: t.name, pm: t.pm.name })),
    sent: list.map((r) => ({ id: r.id, at: r.at, target: r.target, title: inputTitle(e.inputText(r)), state: r.state, ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.error ? { error: r.error } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.card ? { card: r.card } : {}), ...(r.images ? { images: r.images } : {}), page: r.page, ...(r.state === "failed" || r.state === "maybe" ? { text: e.inputText(r) } : {}) })),
  };
}

export function buildView(o: ViewOptions) {
  const { engine } = o;
  // Part J, B4: the cards of a policy that is off are left out.
  const all = [...engine.cards.values()].filter((c) => engine.cardOn(c));
  // Decided: Nil's calls, the actions he finished, and the ones held for
  // their Undo time (DESIGN.md 13.7, 13.8).
  const at = (c: Card) => (c.decision ? markedAt.get(c.decision.event) : c.held ? markedAt.get(c.held.event) : c.state === "withdrawn" ? withdrawnOf.get(c.id)?.at : c.command ? engine.commands.get(c.command)?.doneAt : undefined) ?? "";
  const marks = engine.log.all().filter((e) => e.type === "card.decided" || e.type === "action.held");
  // A withdrawn card is in Decided too, with the event that withdrew it (L167:
  // a card never leaves the queue with no word). Read only.
  const byId = new Map(engine.log.all().map((e) => [e.id, e] as const));
  // reason: the policy's own words (slice 7); without it the page reads the cause.
  const withdrawnOf = new Map<string, { at: string; cause: string | null; reason?: string; task: { title?: string; priority?: string | null; status?: string } | null }>();
  for (const e of engine.log.all()) {
    if (e.type !== "card.withdrawn" || !e.card) continue;
    const cause = e.causedBy ? byId.get(e.causedBy) : undefined;
    const d = cause?.data;
    withdrawnOf.set(e.card, { at: e.at, cause: cause?.type ?? null, ...(typeof e.data?.reason === "string" ? { reason: e.data.reason } : {}), task: d && typeof d === "object" ? { title: d.title, priority: d.priority, status: d.status } : null });
  }
  // When the task was filed in its source (board events carry createdAt), for the sort "Oldest task".
  const filedAt = new Map<string, string>();
  for (const e of engine.log.all())
    if (e.subject && e.type.startsWith("board.task.") && typeof e.data?.createdAt === "number" && !filedAt.has(e.project + "|" + e.subject)) filedAt.set(e.project + "|" + e.subject, new Date(e.data.createdAt).toISOString());
  const markedAt = new Map(marks.map((e) => [e.id, e.at] as const));
  // Decided says whether Nil matched, edited or changed the Premove.
  const outcomeOf = new Map(marks.map((e) => [e.id, e.data?.outcome ?? null] as const));
  const decided = all
    .filter((c) => (c.decision && (c.state === "decided" || c.state === "preparing")) || (c.kind === "action" && (c.state === "done" || (c.state === "open" && c.held))) || c.state === "withdrawn")
    .sort((a, b) => at(b).localeCompare(at(a)))
    .slice(0, DECIDED_MAX);
  const live = all.filter((c) => (c.state === "open" && !c.held) || c.state === "predicting" || (c.state === "preparing" && !c.decision));
  // A card Nil took back with Undo: the call he had made, so any device
  // brings it back (DESIGN.md 13.10). Generic calls are left out.
  const byEvent = new Map(engine.log.all().filter((e) => e.type === "card.decided").map((e) => [e.id, e] as const));
  const undoneOf = new Map<string, { version: number; call: unknown; option: string | null }>();
  for (const e of engine.log.all()) {
    if (e.type !== "card.undone" || !e.card) continue;
    const d = byEvent.get(e.data?.decision);
    if (d && !d.data?.generic) undoneOf.set(e.card, { version: d.data.version, call: d.data.call, option: d.data.option ?? null });
  }
  // What Nil's call started (slice 7): each command of the call, whether it
  // waits, went out, or was not sent and why. Decided shows it.
  // Slice 8 walk: with each reissue after the command it sends again, so the
  // last entry is where the call stands; a failed one says whether its
  // failure card waits (failCard) or Nil dropped it.
  const failCardOpen = (k: CommandRec) => [k.id, k.batch?.[0]].some((id) => id && [...engine.cards.values()].some((x) => x.subject === `command:${id}` && x.state !== "decided" && x.state !== "withdrawn"));
  const sendsOf = (c: Card) =>
    engine.callsOf(c).map((k) => ({
      type: k.type, state: k.state, doneAt: k.doneAt ?? null,
      ...(k.burstMs ? { burstMs: k.burstMs } : {}), ...(k.cancelReason ? { reason: k.cancelReason } : {}), ...(k.error ? { error: k.error } : {}),
      ...(k.maybeSent ? { maybeSent: true } : {}), ...(k.dropped ? { dropped: true } : {}), ...(k.state === "failed" && failCardOpen(k) ? { failCard: true } : {}),
      ...(typeof (k.result as { notSent?: unknown } | undefined)?.notSent === "string" ? { notSent: (k.result as { notSent: string }).notSent } : {}),
    }));
  // A loop-kind card shows its task as the board has it now (Nil, 2026-10-30).
  const infoOf = new Map(engine.policies().filter(({ policy: x }) => x.subjectInfo).map(({ policy: x }) => [x.id, x.subjectInfo!] as const));
  const subjectInfo = (c: Card) => (c.subject && infoOf.has(c.policy) ? (infoOf.get(c.policy)!(engine.state(c.policy), c.subject) ?? null) : null);
  const extra = (c: Card, full: Card = c) => {
    const info = c.state === "open" || c.state === "predicting" ? subjectInfo(c) : null;
    const k = [...engine.commands.values()].filter((x) => x.type === "predict" && x.card === c.id).at(-1);
    const cmd = c.command ? engine.commands.get(c.command) : undefined;
    const action = c.held
      ? { state: "held", ok: c.held.ok, note: c.held.note, until: c.held.until }
      : cmd ? { state: cmd.state, type: cmd.type, note: (cmd.result as { note?: string } | undefined)?.note ?? cmd.error ?? "" } : null;
    return {
      ...c,
      decidedAt: at(c) || null,
      // The consult agent's predict for this version: still working, or done with it.
      predict: k && (k.params as { version?: number })?.version === c.version ? k.state : null,
      ...(action && c.kind === "action" ? { action } : {}),
      // The drafts Nil changed before his call (Decided marks them).
      ...(c.decision ? { editedDrafts: editedDrafts(full), outcome: outcomeOf.get(c.decision.event) ?? null, sends: sendsOf(c), ...(engine.freedOf(c).length ? { freed: engine.freedOf(c).length } : {}), ...(engine.dropOf(c) ? { dropping: engine.dropOf(c)!.commands.length } : {}) } : {}),
      ...(!c.decision && c.kind === "decision" && undoneOf.get(c.id)?.version === c.version ? { undone: undoneOf.get(c.id) } : {}),
      ...(c.state === "withdrawn" ? { withdrawn: withdrawnOf.get(c.id) ?? null } : {}),
      ...(c.subject && filedAt.has(c.project + "|" + c.subject) ? { filedAt: filedAt.get(c.project + "|" + c.subject) } : {}),
      ...(engine.threads.has(c.id) ? { thread: threadOf(engine, c.id) } : {}),
      ...(info ? { subjectInfo: info } : {}),
    };
  };
  const cards = [...live.map((c) => extra(c)), ...decided.map((c) => extra(slim(c), c))];
  const policies = engine.policies().map(({ policy: x, project, builtin }) => ({
    id: x.id, name: nameOf(x), color: colorOf(x), project, projectName: engine.projects().find((d) => d.project === project)?.name ?? null, builtin, on: x.on, emits: x.emits, final: x.final ?? [], commands: x.commands,
    answer: x.answer ?? null, primary: x.primary ?? [], prepare: x.prepare ?? null, author: x.author ?? null, autoAllowed: x.autoAllowed === true,
    undoUntilSent: x.undoUntilSent ?? null, noAuthor: x.noAuthor === true, notePlaceholder: x.notePlaceholder ?? null, subjectLabel: x.subjectLabel === null ? null : (x.subjectLabel ?? "Task"), noNote: x.noNote === true, fallbackHelp: x.fallbackHelp ?? null, noDefault: x.noDefault ?? null, cardKind: x.cardKind ?? null, actionLabel: x.actionLabel ?? null, createdByLabel: x.createdByLabel ?? null, fileDecider: x.decider ?? null, ...engine.deciderOf(x.id), predictor: predictorOf(engine.deciderOf(x.id).config),
  }));
  // Per policy, what it did (the Policies tab): its decision cards, the ones Nil
  // decided now, and its commands by final state; a command an Undo
  // cancelled is "undone", never counted as sent.
  const flow: Record<string, { cards: number; decided: number; commands: Record<string, Record<string, number>> }> = {};
  const fl = (p: string) => (flow[p] ??= { cards: 0, decided: 0, commands: {} });
  for (const c of all) {
    if (c.kind !== "decision") continue;
    fl(c.policy).cards++;
    if (c.decision) fl(c.policy).decided++;
  }
  // The calls Nil took back: a command for one is "undone" (cancelled by the
  // Undo) or "doneThenUndone" (it ran before the Undo).
  const undoneCalls = new Set(engine.log.all().filter((e) => e.type === "card.undone").map((e) => e.data?.decision));
  for (const k of engine.commands.values()) {
    if (!engine.commandOn(k)) continue;
    const live = k.state === "issued" || k.state === "delivered" || k.state === "started";
    const takenBack = undoneCalls.has(k.causedBy) && byId.get(k.causedBy)?.type === "card.decided";
    const state = takenBack && k.state === "cancelled" ? "undone" : takenBack && k.state === "done" ? "doneThenUndone" : live ? "waiting" : k.superseded ? "superseded" : k.state;
    const m = (fl(k.policy).commands[k.type] ??= {});
    m[state] = (m[state] ?? 0) + 1;
  }
  const counts: Record<string, number> = {};
  for (const e of engine.log.all()) if (e.type !== "batch.end") counts[e.type] = (counts[e.type] ?? 0) + 1;
  const projects = engine.projects().map((d) => {
    const consult = d.consult ? d.actors.find((a) => a.id === d.consult) : undefined;
    return {
      project: d.project,
      name: d.name ?? d.project,
      sources: d.sources ?? [],
      events: d.events,
      actors: d.actors.map((a) => ({ ...a, ...(a.kind === "agent" ? { agent: agentOf(o, a.agentName) } : {}) })),
      consult: consult ? { actor: consult.id, kind: consult.kind, ...(consult.kind === "agent" ? { agent: agentOf(o, consult.agentName), skill: consult.skill ?? null } : {}), ...d.consultInfo } : null,
    };
  });
  const accuracy = {
    weeks: weekly(engine.decisions.live()),
    cals: policies.filter((p) => p.answer).map((p) => {
      const set = engine.deciderOf(p.id);
      const sw = set.setAt && set.config?.kind === "threshold" ? { at: set.setAt, min: set.config.min } : null;
      return { policy: p.id, calibration: calibration(engine.decisions.live(), p.id, sw) };
    }),
  };
  // Slice 8: the calls that went out, and whether each landed (a Wall Game call line on the board).
  const landing = engine.policies().flatMap(({ policy }) => (policy.landing ? policy.landing(engine.state(policy.id)).map((l) => ({ ...l, policy: policy.id })) : []));
  return { seq: engine.log.all().at(-1)?.seq ?? 0, cards, policies, projects, counts, flow, replayDiffs: engine.replayDiffs.length, accuracy, chatUrl: o.chatUrl, chatAgent: CHAT_AGENT, agents: roster(o), inputs: inputs(o), officeUrl: OFFICE_URL, sourceAlerts: o.sourceAlerts?.() ?? [], sourceInfo: { asksOff: ASKS_OFF, boardMs: BOARD_MS, inboxMs: INBOX_MS, inbox: INBOX, moved: DEMO ? null : MOVED_NOTE }, landing };
}

function editedDrafts(c: Card): string[] {
  const out: string[] = [];
  const walk = (bs: Block[]) => bs.forEach((b) => (b.type === "draft" ? c.decision!.call[b.key] !== undefined && c.decision!.call[b.key] !== b.text && out.push(b.key) : b.type === "fold" && walk(b.blocks)));
  walk(c.packet?.blocks ?? []);
  return out;
}

// A decided card for the Decided tab: its question and call, not its blocks
// (an Undo brings the full card back at the next read).
function slim(c: Card): Card {
  return { ...c, packet: c.packet ? { question: c.packet.question, blocks: [], options: c.packet.options } : null };
}

// What the consult agent reads about a card (DESIGN.md 13.1): the input it
// was sent, its raw answer, the Premove (its own or a stand-in and why), and
// the decision so far.
// A card's chat (round q1, H1), oldest first. The reply ids stay out: they
// go only into the office message to the consult.
export function threadOf(engine: Engine, id: string) {
  return (engine.threads.get(id) ?? []).map((m) => ({
    id: m.id, by: m.by, at: m.at, version: m.version, text: engine.chatText(m),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.state ? { state: m.state } : {}), ...(m.error ? { error: m.error } : {}),
  }));
}

export function cardContext(engine: Engine, blobs: Blobs, id: string) {
  const c = engine.cards.get(id);
  if (!c) return null;
  const predicts = [...engine.commands.values()].filter((k) => k.type === "predict" && k.card === id).map((k) => ({ id: k.id, version: (k.params as { version?: number })?.version, state: k.state, issuedAt: k.issuedAt, startedAt: k.startedAt ?? null, error: k.error ?? null }));
  const p = c.prediction;
  const latest = [...engine.commands.values()].filter((k) => k.type === "predict" && k.card === id).at(-1);
  const inputName = p?.input ?? (latest?.params as { input?: string } | undefined)?.input;
  return {
    card: { id: c.id, policy: c.policy, project: c.project, version: c.version, state: c.state, question: c.packet?.question ?? null, packet: c.packet, meta: c.meta, decision: c.decision ?? null },
    prediction: p,
    latePrediction: c.latePrediction ?? null,
    input: inputName ? blobs.getText(inputName) : null,
    answer: p?.answer ? blobs.getText(p.answer) : null,
    predicts,
    thread: threadOf(engine, id),
  };
}

// The criteria text of a policy's predictor, for the Setup view.
export function criteriaText(engine: Engine, folderOf: (policy: string) => string | undefined, policy: string): string | null {
  const pr = predictorOf(engine.deciderOf(policy).config);
  const path = pr && "criteria" in pr ? pr.criteria : null;
  const dir = folderOf(policy);
  if (!path || !dir) return null;
  try {
    return readFileSync(isAbsolute(path) ? path : join(dir, path), "utf8");
  } catch {
    return null;
  }
}
