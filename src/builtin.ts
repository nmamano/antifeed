// The app's own policy: command-failed (DESIGN.md section 7). A command that
// failed, or passed its timeoutMs from issued (or started) to done or failed,
// opens a card: retry, reassign or drop. Its decider is nil like any other.

import type { Block, Card, CommandAbout, DeciderStep, Event, OutItem, Packet, Policy } from "./types";

export const BUILTIN_PROJECT = "antifeed";

type Known = { type: string; actor: string; project: string; ms?: number; deadline?: string; about?: CommandAbout; batch?: string[]; notifyDrop?: boolean };
// known: unfinished commands to an agent or code actor. cards: card -> command.
// reissued: commands that are a reissue of a failed one. blocked: failed
// commands whose cause holds until someone fixes it. maybe: failed commands
// that may have gone out. batches: the first command of a failed batch run ->
// all its commands, which share its one card (slice 8). notify: failed
// commands whose owner policy hears of a drop (CommandDecl.notifyDrop).
// drops: card -> a drop that waits for its Undo time (walk 2): its commands,
// and when the owner hears of the drop.
type S = { known: Record<string, Known>; cards: Record<string, string>; reissued?: Record<string, boolean>; blocked?: Record<string, boolean>; maybe?: Record<string, boolean>; batches?: Record<string, string[]>; notify?: Record<string, boolean>; drops?: Record<string, { at: string; commands: string[] }> };

// Nil, 2026-10-20 (loop app): the Undo time of a call, 24 s. The engine holds
// an action's Done, and the dispatcher a call's command, for the same time.
export const CALL_UNDO_MS = 24_000;

const BLOCKED = "A new try fails the same way while this cause holds. Fix the cause first, then pick Send it again.";
const MAYBE = "It may have gone out: a new try may send it twice. Check with the agent first, then pick Send it again or Drop it.";

// A command with plain words (about, slice 7) gets a card in those words,
// with its ids in a fold; any other keeps its ids in view.
type Failed = { id: string; type: string; actor: string; project: string; about?: CommandAbout };
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// Slice 8 walk: a command whose about has Nil's words for one and for many
// (a call to Wall Game PM) gets a card in those words only. The ids and the
// raw cause go in the fold; the buttons and the note use the same names.
function plainPacket(all: Failed[], why: string, blocked: boolean, maybe: boolean, detail?: string): Packet {
  const [k] = all;
  const a = k.about!;
  const n = all.length;
  const them = n > 1 ? "them" : "it";
  const again = `Send ${them} again`;
  const drop = `Drop ${them}`;
  const head = n > 1 ? (a.many ?? a.one!).replace("{n}", String(n)) : a.one!;
  const note = blocked ? `A new try fails the same way while this cause holds. Once it is fixed, pick ${again}.` : maybe ? `${n > 1 ? "They" : "It"} may have gone out, so a new try may send ${them} twice. Check first, then pick ${again} or ${drop}.` : null;
  const ids: [string, string][] = [...all.flatMap((x): [string, string][] => [["Command", x.id], ...(x.about?.ids ?? [])]), ...(detail ? [["Cause", detail] as [string, string]] : []), ["Type", k.type], ["Actor", k.actor], ["Project", k.project]];
  return {
    question: `${head} ${maybe ? "may not have gone out" : "did not go out"}. ${cap(why)}.`,
    blocks: [
      ...all.map((x): Block => ({ type: "fields", rows: [[x.about?.label ?? "Command", x.about?.name ?? x.about?.title ?? x.type], ...(x.about?.rows ?? [])] })),
      ...(note ? [{ type: "markdown", text: note } as Block] : []),
      { type: "fold", title: "Ids, for a bug report", blocks: [{ type: "fields", rows: ids }] },
    ],
    options: [
      { id: "retry", label: again, fill: { choice: "retry" } },
      { id: "drop", label: drop, fill: { choice: "drop" } },
    ],
    ...(a.noReassign ? { limit: { choice: ["retry", "drop"], actor: null } } : {}),
  };
}

const packetFor = (k: Failed, why: string, blocked = false, maybe = false, more: Failed[] = [], detail?: string): Packet => {
  if (k.about?.one) return plainPacket([k, ...more], why, blocked, maybe, detail);
  const ids: Block = { type: "fields", rows: [["Command", k.id], ["Type", k.type], ["Actor", k.actor], ["Project", k.project]] };
  const note: Block[] = blocked ? [{ type: "markdown", text: BLOCKED }] : maybe ? [{ type: "markdown", text: MAYBE }] : [];
  const head = maybe ? "did not surely go out" : "did not go out";
  // A batch run (slice 8): one card, with each command of the run in its own rows.
  if (more.length) {
    const all = [k, ...more];
    return {
      question: `${all.length} commands sent together to ${k.actor} (${k.project}) ${head}: ${why}`,
      blocks: [
        ...all.map((x): Block => ({ type: "fields", rows: [["Command", x.about?.title ?? x.type], ...(x.about?.rows ?? [])] })),
        ...note,
        { type: "markdown", text: "Send it again sends them all again, together." },
        { type: "fold", title: "Ids, for a bug report", blocks: [{ type: "fields", rows: all.map((x): [string, string] => [x.id, x.type]) }] },
      ],
      options: [
        { id: "retry", label: "Send them all again to the same actor", fill: { choice: "retry" } },
        { id: "drop", label: "Drop them", fill: { choice: "drop" } },
      ],
    };
  }
  const blocks: Block[] = k.about
    ? [...(k.about.rows?.length ? [{ type: "fields", rows: k.about.rows } as Block] : []), ...note, { type: "fold", title: "Ids, for a bug report", blocks: [ids] }]
    : [ids, ...note];
  return {
    question: k.about ? `${k.about.title} ${head}: ${why}` : `${k.type} to ${k.actor} (${k.project}) did not finish: ${why}`,
    blocks,
    options: [
    { id: "retry", label: "Send it again to the same actor", fill: { choice: "retry" } },
    { id: "drop", label: "Drop it", fill: { choice: "drop" } },
  ],
  };
};

const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

export const commandFailed: Policy<S> = {
  id: "command-failed",
  name: "Failed command",
  color: "#b4441c",
  // The command id is in the packet (or its fold), not in the head (walk round 3: it made a phone page too wide).
  subjectLabel: null,
  on: ["command.issued", "command.started", "command.done", "command.failed", "command.cancelled"],
  emits: [],
  commands: {},
  // Its Premove (DESIGN.md 13.1): retry a first failure, drop a failed retry.
  decider: { kind: "nil", predictor: { kind: "code", handler: "retry-once" } },
  answer: {
    choice: { enum: ["retry", "reassign", "drop"], label: "Call" },
    actor: { text: { max: 100 }, label: "New actor", help: "For reassign: the actor id that gets the command instead." },
  },
  primary: ["choice"],
  fallback: { choice: "retry" },
  // Slice 8 walk: once a retry went out, its call cannot be taken back, so
  // an Undo never opens the card for a second send.
  undoUntilSent: "Your call sent it again already; it cannot be taken back.",
  // Walk 2: no author or actor reads this note.
  notePlaceholder: "Note: stays with your call in your decision log",
  init: { known: {}, cards: {} },
  reduce(state, e: Event) {
    const s: S = { known: { ...state.known }, cards: { ...state.cards }, reissued: { ...state.reissued }, blocked: { ...state.blocked }, maybe: { ...state.maybe }, batches: { ...state.batches }, notify: { ...state.notify }, drops: { ...state.drops } };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    const open = (id: string, k: Known, why: string, blocked = false, maybe = false, more: Failed[] = []) =>
      out.push({ open: { subject: `command:${id}`, meta: { source: "Antifeed", raw: `command:${id}` }, packet: packetFor({ id, ...k }, why, blocked, maybe, more, typeof d.detail === "string" ? d.detail : undefined) } });
    switch (e.type) {
      case "command.issued":
        // Nil's own actions (action cards) do not come back to him as failures,
        // and a predict that fails gets a stand-in, not a card (DESIGN.md 13.1).
        if (!e.command || d.actorKind === "human" || d.type === "predict") break;
        if (d.reissue) s.reissued![e.command] = true;
        s.known[e.command] = { type: d.type, actor: d.actor, project: e.project ?? "", ...(d.about ? { about: d.about } : {}), ...(d.notifyDrop ? { notifyDrop: true } : {}), ...(d.timeoutMs ? { ms: d.timeoutMs, deadline: plus(e.at, d.timeoutMs) } : {}) };
        if (d.timeoutMs) out.push({ wakeAt: s.known[e.command].deadline! });
        break;
      case "command.started": {
        // The clock starts again at the start and runs up to done or failed.
        const k = e.command ? s.known[e.command] : undefined;
        if (k && Array.isArray(d.batch) && d.batch.length > 1) s.known[e.command!] = { ...k, batch: d.batch };
        if (k?.ms) {
          s.known[e.command!] = { ...k, deadline: plus(e.at, k.ms) };
          out.push({ wakeAt: s.known[e.command!].deadline! });
        }
        break;
      }
      case "command.done":
      case "command.cancelled":
        if (e.command) delete s.known[e.command];
        break;
      case "command.failed": {
        const k = e.command ? s.known[e.command] : undefined;
        if (k) {
          delete s.known[e.command!];
          if (d.blocked) s.blocked![e.command!] = true;
          if (d.maybeSent) s.maybe![e.command!] = true;
          if (k.notifyDrop) s.notify![e.command!] = true;
          // A batch run fails all its commands at once: the first one opens
          // the card for all (they are still known), the others add none.
          const lead = k.batch?.[0];
          if (lead && lead === e.command) {
            s.batches![lead] = k.batch!;
            const more = k.batch!.slice(1).flatMap((id) => (s.known[id] ? [{ id, ...s.known[id] }] : []));
            open(e.command!, k, d.error ?? "failed", !!d.blocked, !!d.maybeSent, more);
          } else if (!lead || !s.batches![lead]) open(e.command!, k, d.error ?? "failed", !!d.blocked, !!d.maybeSent);
        }
        break;
      }
      case "clock.tick":
        // A command whose policy is off (the tick names it) gets no timeout
        // card; it stays known, so a tick after its switch-on opens one.
        for (const [id, k] of Object.entries(s.known))
          if (k.deadline && k.deadline <= e.at && !(d.off ?? []).includes(id)) {
            delete s.known[id];
            open(id, k, "no result before its timeout");
          }
        // A drop whose Undo time ended: now the owner policy hears of it.
        for (const [card, x] of Object.entries(s.drops!))
          if (x.at <= e.at) {
            delete s.drops![card];
            for (const k of x.commands) out.push({ dropped: { command: k } });
          }
        break;
      case "card.opened":
        if (e.card && typeof e.subject === "string") s.cards[e.card] = e.subject.slice("command:".length);
        break;
      case "card.decided": {
        const id = e.card && s.cards[e.card];
        if (!id || d.generic) break;
        // A batch's card sends all of its commands again, so they go together again.
        for (const k of s.batches?.[id] ?? [id]) {
          if (d.call?.choice === "retry") out.push({ reissue: { command: k } });
          if (d.call?.choice === "reassign") out.push({ reissue: { command: k, actor: d.call.actor ?? undefined } });
        }
        // Walk 2: a drop keeps the Undo time of every other call. The owner
        // hears of it, and frees what the commands held, only when it ends.
        const notify = (s.batches?.[id] ?? [id]).filter((k) => s.notify?.[k]);
        if (d.call?.choice === "drop" && notify.length) {
          s.drops![e.card!] = { at: plus(e.at, CALL_UNDO_MS), commands: notify };
          out.push({ wakeAt: s.drops![e.card!].at });
        }
        break;
      }
      case "card.undone":
        // Undo inside the Undo time: the drop never happened.
        if (e.card) delete s.drops![e.card];
        break;
    }
    return { state: s, out };
  },
};

// The built-in policy's Premove: a first failure is often a passing problem.
export const builtinHandlers = {
  "retry-once": ({ card, state }: { card: Card; state: unknown }): DeciderStep => {
    const id = (state as S).cards[card.id];
    const again = !!id && !!(state as S).reissued?.[id];
    // Walk 2: the words name the card's own button, and "them" for a card of more than one command.
    const many = !!id && ((state as S).batches?.[id]?.length ?? 1) > 1;
    const them = many ? "them" : "it";
    const send = card.packet?.options?.find((o) => o.id === "retry")?.label ?? `Send ${them} again`;
    // Slice 7: no retry while the cause holds (Inbox access off).
    if (id && (state as S).blocked?.[id])
      return { kind: "ask", prediction: { call: { choice: "drop" }, confidence: 0.6, why: "A new try fails the same way while the cause holds.", against: `Once you fix the cause, ${send} sends ${them}.`, by: "code:retry-once", precedent: [] } };
    // Slice 8: a send that may have gone out is not tried again by default.
    if (id && (state as S).maybe?.[id])
      return { kind: "ask", prediction: { call: { choice: "drop" }, confidence: 0.6, why: `${many ? "They" : "It"} may have gone out: a new try may send ${them} twice.`, against: `If the agent says it got nothing, ${send} sends ${them} once.`, by: "code:retry-once", precedent: [] } };
    return {
      kind: "ask",
      prediction: again
        ? { call: { choice: "drop" }, confidence: 0.6, why: many ? "These commands already failed once and were sent again." : "This command already failed once and was sent again.", against: "The actor may have been busy both times; one more try costs little.", by: "code:retry-once", precedent: [] }
        : { call: { choice: "retry" }, confidence: 0.6, why: "A first failure is often a passing problem: a busy or restarted agent.", against: many ? "If the commands themselves are wrong, a retry fails the same way." : "If the command itself is wrong, a retry fails the same way.", by: "code:retry-once", precedent: [] },
    };
  },
};
