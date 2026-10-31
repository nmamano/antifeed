// Isomux sign-off (Part J, Nil's go 2026-10-30: "can we move sign off packets
// to anti-feed?"; push stays in the Loop app). Each merged item that waits
// on the Loop app's Sign-off list gets a card. Isomux Sign-off Scout writes
// the packet (its pick, Approve or Revert, and its verdict); Nil decides;
// Antifeed presses the Loop app's buttons as its page does (approve, reject,
// undo), and the Loop app files the changes task, holds and sends the revert
// and computes the push point itself. Antifeed writes to the Loop app only
// for this kind, which Nil moved to it, and only on his call.
import { Failed, MaybeSent, type Handler, type RunContext } from "../../src/policies";
import type { CommandRec } from "../../src/engine";
import type { Actor, Call, Card, Event, OutItem, Packet, Policy, SubjectInfo } from "../../src/types";
import type { SignoffItemData } from "../../src/loop-signoff";

// The switch (Isomux PM's spec, 2026-10-30): true makes a card for each
// waiting item; false makes no cards and no writes. The Loop app's own
// Sign-off tab works either way.
export const SIGNOFF_IN_ANTIFEED = false;

// The Loop app: the live one, or a copy for a check (ANTIFEED_LOOP_URL).
export const loopUrl = () => (process.env.ANTIFEED_LOOP_URL || "http://127.0.0.1:21025").replace(/\/$/, "");
// The Loop app sends a revert request to Isomux Main this long after the
// rejection (its REVERT_HOLD_MS); Antifeed's Undo stops a little before.
export const REVERT_HOLD_MS = 60_000;
// Antifeed's Undo of a revert stops this long before the Loop app sends it (Reviewer m2).
const REVERT_UNDO_MARGIN_MS = 20_000;
export const SCOUT = "Isomux Sign-off Scout";

type Item = Omit<SignoffItemData, "sig"> & { loopState: string; pushgo?: boolean };
export type SignoffState = {
  items: Record<string, Item>;
  // task id -> its card, from its opening until the item leaves the list
  card: Record<string, string>;
  cardTask: Record<string, string>;
  cardState: Record<string, "waiting" | "open" | "decided">;
  // card -> the signoff.apply that is not finished, and where it is
  apply: Record<string, string>;
  applyState: Record<string, "issued" | "started">;
  // card -> the call that reached the Loop app, and when; due: when the Loop app sends a revert to Isomux Main
  applied: Record<string, { call: string; at: string; due?: number }>;
  // card -> the merge its current packet shows (Reviewer B2: Nil's call goes to the merge he saw)
  cardCommit: Record<string, string>;
  // card -> the signoff.undo that is not finished
  undo: Record<string, string>;
};

export type Comments = { copy: Record<string, string>; images: Record<string, string> };
// The call's comments: JSON text {copy: {index: text}, images: {index: text}}, by the Loop app's entry and image indices.
export function parseComments(text: unknown): Comments | string {
  if (text == null || text === "") return { copy: {}, images: {} };
  let v: unknown;
  try {
    v = JSON.parse(String(text));
  } catch {
    return "comments must be JSON: {copy: {index: text}, images: {index: text}}";
  }
  const map = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) && Object.entries(x).every(([k, t]) => /^\d+$/.test(k) && typeof t === "string" && t.length <= 4000);
  const o = v as Comments;
  if (!o || typeof o !== "object" || !map(o.copy ?? {}) || !map(o.images ?? {})) return "comments must be {copy: {index: text}, images: {index: text}}, each text at most 4000 characters";
  const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m ?? {}).filter(([, t]) => t.trim()));
  return { copy: clean(o.copy), images: clean(o.images) };
}
const hasComments = (c: Comments) => Object.keys(c.copy).length + Object.keys(c.images).length > 0;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
export const sameCommit = (a?: string | null, b?: string | null) => !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
const pickOf = (p: Packet | null) => p?.options?.find((o) => o.id === p.recommended) ?? null;
const whyOf = (p: Packet | null) => ((p?.blocks ?? []).find((b) => b.type === "markdown") as { text?: string } | undefined)?.text?.trim() ?? "";

const about = (s: SignoffState, taskId: string, what: string) => ({
  title: `${what}: ${s.items[taskId]?.title ?? taskId}`,
  one: what,
  many: `${what} (several)`,
  label: "Item",
  name: s.items[taskId]?.title ?? taskId,
  to: "the Loop app",
  ids: [["Task", taskId], ["Commit", s.items[taskId]?.commit ?? ""]] as [string, string][],
  noReassign: true,
});

export const signoff: Policy<SignoffState> = {
  id: "signoff",
  name: "Sign-off",
  color: "#7a3fb0",
  on: ["signoff.item.waiting", "signoff.item.left", "signoff.item.pushgo"],
  emits: ["signoff.decided"],
  final: ["signoff.decided"],
  commands: {
    "signoff.prepare": { actor: "scout", delivery: "at-least-once", timeoutMs: 2 * 3_600_000, what: "write the sign-off packet of a merged item: your pick, Approve or Revert", when: "For each item that waits on the Loop app's Sign-off list, and again after a new merge" },
    "signoff.apply": { actor: "loopapp", delivery: "at-most-once", what: "press Approve or Revert on the Loop app for your call", when: "After your call, once its Undo time is over" },
    "signoff.undo": { actor: "loopapp", delivery: "at-most-once", what: "press Undo on the Loop app", when: "When you undo a call that reached the Loop app" },
  },
  // The Scout's pick is the Premove (Isomux PM's spec): no model run, no consult.
  decider: { kind: "nil", predictor: { kind: "code", handler: "authorPick" } },
  autoAllowed: false,
  // Above the chips plain words only; the folds hold file paths by design.
  plainWords: "above-folds",
  cardKind: "loop",
  loopCompare: ["call"],
  subjectLabel: "Task",
  author: "scout",
  prepare: "signoff.prepare",
  answer: {
    call: { enum: ["approve", "revert"], label: "Call" },
    comments: { text: { max: 100_000 }, label: "Comments", help: "Your comments on each string and screenshot." },
  },
  primary: ["call"],
  // No basis for a Premove: Approve, the call Nil makes on most items.
  fallback: { call: "approve" },
  fallbackHelp: "Approve: the Loop app takes it for the next push",
  validate: (call: Call) => {
    if (call.call === "revert" && !String(call.note ?? "").trim()) return "Revert needs a note: what is wrong, for Isomux Main";
    const c = parseComments(call.comments);
    return typeof c === "string" ? c : null;
  },
  checkPacket: (p: Packet, meta: Record<string, unknown>) => {
    const pick = pickOf(p);
    if ((p.options ?? []).length !== 1 || !pick) return 'a sign-off packet has one option, your pick, named in recommended: {"id":"pick","label":"Approve","fill":{"call":"approve"}}';
    if (!["approve", "revert"].includes(String(pick.fill?.call)) || Object.keys(pick.fill).some((k) => k !== "call")) return 'the pick\'s fill is {"call":"approve"} or {"call":"revert"}';
    const tops = p.blocks.filter((b) => b.type !== "fold");
    if (tops.filter((b) => b.type === "markdown").length !== 1 || tops[0]?.type !== "markdown") return "the first block is the why: one markdown block, your one-line reason";
    const n = words(whyOf(p));
    if (n > 15) return `the why is ${n} words; the cap is 15`;
    if (tops.some((b) => b.type !== "markdown" && b.type !== "image")) return "above the folds a sign-off packet has the why and its images only";
    if (tops.filter((b) => b.type === "image").length > 2) return "above the folds at most one image pair or one image";
    if (typeof meta.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(meta.commit)) return "meta.commit is the merge you read: the commit from the command's params (7 to 40 hex digits)";
    const s = meta.scout as Record<string, unknown> | undefined;
    if (!s || !["stamp", "look", "pushback"].includes(String(s.verdict))) return 'meta.scout.verdict is "stamp", "look" or "pushback"';
    if (typeof s.confidence !== "number" || !(s.confidence >= 0 && s.confidence <= 1)) return "meta.scout.confidence is a number from 0 to 1";
    const sug = s.suggestions as Comments | undefined;
    const ok = (m: unknown) => m === undefined || (!!m && typeof m === "object" && Object.entries(m as object).every(([k, t]) => /^\d+$/.test(k) && typeof t === "string" && t.length <= 4000));
    if (sug !== undefined && (typeof sug !== "object" || !ok(sug.copy) || !ok(sug.images))) return "meta.scout.suggestions is {copy: {index: text}, images: {index: text}}";
    return null;
  },
  undoRefusal: (s: SignoffState, card: Card, now: number) => {
    if (s.applyState[card.id] === "started") return "Your call is on its way to the Loop app; try Undo again in a few seconds.";
    if (s.undo[card.id]) return "An Undo of this call is on its way to the Loop app already.";
    const a = s.applied[card.id];
    if (!a) return null;
    if (a.call === "revert" && now > (a.due ?? Date.parse(a.at) + REVERT_HOLD_MS) - REVERT_UNDO_MARGIN_MS) return "Isomux Main has the revert request already (the Loop app sends it 60 s after your Revert); this revert cannot be undone.";
    const t = s.cardTask[card.id];
    if (a.call === "approve" && t && (s.items[t]?.loopState === "gone" || s.items[t]?.pushgo)) return "A push go took this approval already; it cannot be undone.";
    return null;
  },
  subjectInfo: (s: SignoffState, id: string): SubjectInfo | null => {
    const i = s.items[id];
    if (!i) return null;
    return { title: i.title, priority: null, description: i.summary, createdAt: i.mergedAt, signoff: { taskId: id, commit: i.commit, mergedAt: i.mergedAt, summary: i.summary, copy: i.copy, images: i.images, loopState: i.loopState } };
  },
  init: { items: {}, card: {}, cardTask: {}, cardState: {}, apply: {}, applyState: {}, applied: {}, cardCommit: {}, undo: {} },
  reduce(state, e: Event) {
    const s: SignoffState = {
      items: { ...state.items }, card: { ...state.card }, cardTask: { ...state.cardTask }, cardState: { ...state.cardState },
      apply: { ...state.apply }, applyState: { ...state.applyState }, applied: { ...state.applied }, cardCommit: { ...state.cardCommit }, undo: { ...state.undo },
    };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    const prepare = (id: string, card?: string, revise?: string): OutItem =>
      card
        ? { issue: { type: "signoff.prepare", card, subject: id, params: { taskId: id, commit: s.items[id].commit, images: s.items[id].images, ...(revise ? { revise } : {}) } } }
        : { open: { subject: id, meta: { source: "loop", raw: `https://office.example.com/loop/signoff/${id}` }, prepare: { type: "signoff.prepare", params: { taskId: id, commit: s.items[id].commit, images: s.items[id].images } } } };
    switch (e.type) {
      case "signoff.item.waiting": {
        const id = e.subject!;
        const before = s.items[id];
        const { sig: _sig, ...item } = d as SignoffItemData;
        s.items[id] = { ...item, loopState: "waiting" };
        const c = s.card[id];
        if (!c) {
          out.push(prepare(id));
          break;
        }
        if (s.cardState[c] === "decided") {
          // Waiting again after Nil's call: undone on the Loop app's tab, or a new merge. A call not sent yet does not go (F1); a new card shows the item.
          if (s.apply[c] && s.applyState[c] === "issued") out.push({ cancel: s.apply[c], reason: "Not sent: the item waits on the Loop app again, so a new card shows it." });
          delete s.card[id];
          out.push(prepare(id));
          break;
        }
        // A re-merge, or a re-posted item: the card's next version. Back after
        // an Undo with the same commit: the card is open already, as it was.
        if (before && before.commit !== item.commit) out.push(prepare(id, c, "the item was merged again: a new commit"));
        else if (before && before.loopState === "waiting") out.push(prepare(id, c, "the item changed on the Loop app: its copy or screenshots"));
        break;
      }
      case "signoff.item.pushgo": {
        const id = e.subject!;
        if (s.items[id]) s.items[id] = { ...s.items[id], pushgo: true };
        break;
      }
      case "signoff.item.left": {
        const id = e.subject!;
        if (s.items[id]) s.items[id] = { ...s.items[id], loopState: String(d.state) };
        const c = s.card[id];
        if (!c) break;
        if (s.cardState[c] === "decided") {
          // Decided here and there (the Loop app's tab, or a revert or push), before the call went: it does not go (F1).
          if (s.apply[c] && s.applyState[c] === "issued") out.push({ cancel: s.apply[c], reason: `Not sent: the item was ${d.state === "gone" ? "taken off the Loop app's list" : `${d.state} on the Loop app's tab`} first.` });
        } else out.push({ withdraw: c, reason: d.state === "gone" ? "The item left the Loop app's Sign-off list." : `You decided it on the Loop app's tab (${d.state}).` });
        if (d.state === "gone") delete s.card[id];
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        s.cardTask[e.card!] = e.subject!;
        s.cardState[e.card!] = "waiting";
        break;
      case "card.packet":
        if (s.cardState[e.card!] !== "decided") s.cardState[e.card!] = "open";
        if (typeof d.meta?.commit === "string") s.cardCommit[e.card!] = d.meta.commit;
        break;
      case "card.withdrawn": {
        const t = s.cardTask[e.card!];
        if (t && s.card[t] === e.card) delete s.card[t];
        delete s.cardState[e.card!];
        break;
      }
      case "card.decided": {
        const taskId = s.cardTask[e.card!];
        if (!taskId || d.generic) break;
        s.cardState[e.card!] = "decided";
        const comments = parseComments(d.call.comments);
        const params = { taskId, commit: s.cardCommit[e.card!] ?? s.items[taskId]?.commit, call: d.call.call, note: String(d.call.note ?? "").trim(), comments: typeof comments === "string" ? { copy: {}, images: {} } : comments };
        out.push({ emit: { type: "signoff.decided", subject: taskId, data: { call: d.call } } });
        out.push({ issue: { type: "signoff.apply", card: e.card, subject: taskId, params, about: about(s, taskId, d.call.call === "revert" ? "Your Revert on the Loop app" : "Your Approve on the Loop app") } });
        break;
      }
      case "card.undone": {
        const taskId = s.cardTask[e.card!];
        s.cardState[e.card!] = "open";
        // A newer card shows the item (a re-merge after this call): this one goes.
        if (taskId && s.card[taskId] && s.card[taskId] !== e.card) out.push({ withdraw: e.card!, reason: "A newer card shows the item at its new merge." });
        if (taskId && !s.card[taskId]) s.card[taskId] = e.card!;
        if (s.apply[e.card!]) out.push({ cancel: s.apply[e.card!] });
        else if (s.applied[e.card!] && taskId) out.push({ issue: { type: "signoff.undo", card: e.card, subject: taskId, params: { taskId }, about: about(s, taskId, "Your Undo on the Loop app") } });
        delete s.applied[e.card!];
        break;
      }
      case "command.issued":
        if (d.type === "signoff.apply" && d.card) {
          s.apply[d.card] = e.command!;
          s.applyState[d.card] = "issued";
        }
        if (d.type === "signoff.undo" && d.card) s.undo[d.card] = e.command!;
        break;
      case "command.started":
        for (const [c, k] of Object.entries(s.apply)) if (k === e.command) s.applyState[c] = "started";
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        for (const [c, k] of Object.entries(s.apply))
          if (k === e.command) {
            delete s.apply[c];
            delete s.applyState[c];
            const r = d.result as { sent?: string; at?: string; revertIn?: number; notSent?: string } | undefined;
            if (e.type === "command.done" && r?.sent) s.applied[c] = { call: r.sent, at: e.at, ...(typeof r.revertIn === "number" ? { due: Date.parse(e.at) + r.revertIn } : {}) };
            // Not sent, and the item still waits (a re-merge Nil did not see): a new card shows it.
            const t = s.cardTask[c];
            if (e.type === "command.done" && r?.notSent && t && s.card[t] === c && s.items[t]?.loopState === "waiting") {
              delete s.card[t];
              out.push(prepare(t));
            }
          }
        for (const [c, k] of Object.entries(s.undo)) if (k === e.command) delete s.undo[c];
        break;
    }
    return { state: s, out };
  },
};

// The Premove: the Scout's pick, with its confidence (Isomux PM's spec: a code predictor, no model run).
export const authorPick: Handler = ({ card }) => {
  const pick = pickOf(card.packet);
  if (!pick || !["approve", "revert"].includes(String(pick.fill?.call))) return { kind: "ask", prediction: null };
  const why = whyOf(card.packet) || "The Scout's pick.";
  return {
    kind: "ask",
    prediction: {
      call: { call: pick.fill.call, ...(pick.fill.call === "revert" ? { note: why } : {}) },
      confidence: card.meta.scout?.confidence ?? 0.5,
      why,
      against: "",
      by: "code:authorPick",
      precedent: [],
    },
  };
};

// The Loop app's buttons, pressed as its page does (no member identity on these routes).
async function press(path: string, body?: unknown): Promise<Response> {
  return fetch(`${loopUrl()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}
const errorOf = async (r: Response) => {
  const t = await r.text().catch(() => "");
  try {
    return String((JSON.parse(t) as { error?: string }).error ?? t);
  } catch {
    return t;
  }
};

// signoff.apply and signoff.undo (a 4xx is a failed card with the Loop app's
// words; a 5xx or no answer "may have gone": F2, as Wall Game's sends).
export async function loopApp(k: CommandRec, _ctx: RunContext): Promise<unknown> {
  const p = k.params as { taskId: string; commit?: string; call?: string; note?: string; comments?: Comments };
  const id = encodeURIComponent(p.taskId);
  if (k.type === "signoff.undo") {
    let r: Response;
    try {
      r = await press(`/api/signoff/${id}/undo`);
    } catch (err) {
      throw new MaybeSent("the Loop app gave no answer to the Undo; look at its Sign-off tab", (err as Error).message);
    }
    if (r.status >= 400 && r.status < 500) throw new Failed(`the Loop app refused the Undo: ${await errorOf(r)}`, `POST /api/signoff/${p.taskId}/undo answered ${r.status}`);
    if (!r.ok) throw new MaybeSent("the Loop app gave no clear answer to the Undo; look at its Sign-off tab", `POST /api/signoff/${p.taskId}/undo answered ${r.status}`);
    return { undone: true };
  }
  // F1: the call goes only while the item still waits with the same commit.
  let list: { items?: { taskId: string; state: string; merged: { commit: string } | null }[] };
  try {
    const r = await fetch(`${loopUrl()}/api/signoff`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`GET /api/signoff answered ${r.status}`);
    list = await r.json();
  } catch (err) {
    throw new Failed("the Loop app did not answer, so nothing was sent", (err as Error).message);
  }
  const it = (list.items ?? []).find((x) => x.taskId === p.taskId);
  // Reviewer m4: the same merge by prefix (7 hex digits or more), as the Loop app's pushed() compares.
  const same = sameCommit(it?.merged?.commit, p.commit);
  if (!it || it.state !== "waiting" || !same) return { notSent: `the item is ${it ? (!same ? "at a new merge" : it.state) : "off the list"} on the Loop app now` };
  // Always: the Loop app keeps an item's comments (across an Undo, and as typed on its own tab) and files
  // the changes task from the stored ones, so Nil's call replaces them, with empty maps when he has none (Reviewer B1).
  const comments = p.comments ?? { copy: {}, images: {} };
  {
    let r: Response;
    try {
      r = await press(`/api/signoff/${id}/comments`, { copy: comments.copy ?? {}, images: comments.images ?? {} });
    } catch (err) {
      throw new Failed("the Loop app did not take your comments, so nothing was sent", (err as Error).message);
    }
    if (!r.ok) throw new Failed(`the Loop app did not take your comments (${await errorOf(r)}), so nothing was sent`, `POST /api/signoff/${p.taskId}/comments answered ${r.status}`);
  }
  const route = p.call === "revert" ? "reject" : "approve";
  const body = p.call === "revert" || p.note || hasComments(comments) ? { note: p.note ?? "" } : undefined;
  let r: Response;
  try {
    r = await press(`/api/signoff/${id}/${route}`, body);
  } catch (err) {
    throw new MaybeSent(`the Loop app gave no answer to your ${p.call === "revert" ? "Revert" : "Approve"}; look at its Sign-off tab`, (err as Error).message);
  }
  if (r.status >= 400 && r.status < 500) throw new Failed(`the Loop app refused it: ${await errorOf(r)}`, `POST /api/signoff/${p.taskId}/${route} answered ${r.status}`);
  if (!r.ok) {
    const why = await errorOf(r);
    // Reviewer m1: the board refused the changes task, and the Loop app says the item is not approved: nothing was done.
    if (r.status === 502 && /not approved yet/.test(why)) throw new Failed(`the Loop app did not approve it: ${why}`, `POST /api/signoff/${p.taskId}/${route} answered 502`);
    throw new MaybeSent(`the Loop app gave no clear answer (${r.status}); look at its Sign-off tab`, `POST /api/signoff/${p.taskId}/${route} answered ${r.status}`);
  }
  // Reviewer m2: the Loop app's revertIn (ms from its answer) goes in the result, so the log holds it;
  // the reducer counts it from the command.done time.
  const answer = (await r.json().catch(() => ({}))) as { revertIn?: number };
  return { sent: p.call, at: new Date().toISOString(), filesTask: p.call === "approve" && (!!p.note || hasComments(comments)), ...(p.call === "revert" && typeof answer.revertIn === "number" ? { revertIn: answer.revertIn } : {}) };
}

// The project's parts for sign-off, behind the switch.
type Parts = {
  actors: Actor[];
  sources: { id: string; kind: string }[];
  events: Record<string, { from: string; what: string }>;
  policies: Policy[];
  handlers: Record<string, Handler>;
  run: Record<string, (k: CommandRec, ctx: RunContext) => unknown>;
  agents: Record<string, string>;
};
export function signoffParts(on = SIGNOFF_IN_ANTIFEED): Parts {
  if (!on) return { actors: [], sources: [], events: {}, policies: [], handlers: {}, run: {}, agents: {} };
  return {
    actors: [
      { id: "scout", kind: "agent", agentName: SCOUT, skill: "isomux-signoff-scout" },
      { id: "loopapp", kind: "code", handler: "loopapp" },
    ] as Actor[],
    sources: [{ id: "loop", kind: "loop-signoff" }],
    events: {
      "signoff.item.waiting": { from: "loop", what: "a merged item that waits for your sign-off on the Loop app" },
      "signoff.item.left": { from: "loop", what: "an item that no longer waits on the Loop app: decided, reverted or pushed" },
      "signoff.item.pushgo": { from: "loop", what: "a push go took an approved item: its approval can no longer be undone" },
      "signoff.decided": { from: "signoff", what: "your sign-off call on an item" },
    },
    policies: [signoff] as Policy[],
    handlers: { authorPick } as Record<string, Handler>,
    run: { loopapp: loopApp },
    agents: { [SCOUT]: "writes each sign-off packet: its pick, Approve or Revert, its reason, and the comments it suggests" },
  };
}
