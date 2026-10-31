// Wall Game video review (Nil, 2026-10-30: "i want the video reviews for wall
// game to show up here as a new kind. can you wire this?"). Each finished
// daily video that waits in the game-video app's review queue gets a card:
// its video and its caption, and the few lines the app's page shows (Nil,
// 2026-10-28: "I literally only need to see the videos and captions.
// Everything else is context i don't need."). Nil decides Approve, Revise or
// Discard; after the call's hold Antifeed presses the app's own route, with
// the hashes of what he saw, as its page does. The app logs it and tells the
// Wall Game Director itself: Antifeed sends nothing else. The page on the
// app's port stays live and untouched.
import { NIL_MEMBER_ID, NIL_NAME } from "../../src/config";
import type { CommandRec } from "../../src/engine";
import { memberHeader, type VideoItemData, type VideoMember } from "../../src/game-video";
import { Failed, MaybeSent, type Handler, type RunContext } from "../../src/policies";
import type { Actor, Block, Call, Event, OutItem, Packet, Policy } from "../../src/types";

// The switch: true makes a card for each video in review; false loads nothing.
// Off since Nil, 2026-10-31 ("tell wall game director to move the approval
// feed to asks"): Wall Game Director opens one ask per video in his Inbox
// (DESIGN.md 22).
export const VIDEO_IN_ANTIFEED = false;
export const VIDEO_PORT = 21006;
// Only Nil reviews (review.mjs): his member id and name go in the app's member headers.
export const VIDEO_MEMBER: VideoMember = { id: NIL_MEMBER_ID, name: NIL_NAME };
let base = `http://127.0.0.1:${VIDEO_PORT}`;
export const videoUrl = () => base;
// A copy of Antifeed (no office token) and the tests point it elsewhere, so they never press the live app.
export function setVideoUrl(url: string): void {
  base = url.replace(/\/$/, "");
}

const ACTIONS = ["approve", "revise", "discard"] as const;
const WORD: Record<string, string> = { approve: "Approve", revise: "Revise", discard: "Discard" };
// The page's own words when Approve cannot work now (store.mjs approveProblem).
export const APPROVE_NO = "Approve cannot be taken now: ";
// The note the app gets is Nil's note word for word, then this line, so the
// app's feedback log and the Director see where the call came from (Wall Game
// PM's condition 3, 2026-10-30). The card and the decision log keep his note alone.
export const VIA = "(via Antifeed)";
export const sentNotes = (note: string) => (note ? `${note}\n${VIA}` : VIA);
// The app takes notes of at most 4000 characters (store.mjs NOTES_MAX), with the line above.
const NOTES_MAX = 4000 - VIA.length - 1;
export const NOT_SENT_CHANGED = "Not sent: the video changed since you saw it. The next read of the review queue shows it on a new card.";
export const NOT_SENT_GONE = "Not sent: the video is no longer in review.";
export const UNDO_WORDS = "Your call went to the video page, so it cannot be undone here. An approval can be undone on the page's Approved tab (Undo approval).";

type Hashes = { videoSha256: string; copySha256: string };
type Item = Omit<VideoItemData, "sig"> & { inQueue: boolean };
export type VideoState = {
  items: Record<string, Item>;
  // item id -> its card, from its opening until a decision on it is done with
  card: Record<string, string>;
  cardItem: Record<string, string>;
  cardState: Record<string, "open" | "decided">;
  // card -> the hashes of the video and copy its current packet shows
  cardHash: Record<string, Hashes>;
  // card -> the video.apply that is not finished
  apply: Record<string, string>;
};

export function packetOf(i: Omit<VideoItemData, "sig">): Packet {
  const blocks: Block[] = [{ type: "video", blob: i.blob }];
  if (i.youtubeTitle) blocks.push({ type: "markdown", text: `YouTube: ${i.youtubeTitle}` });
  for (const k of i.claimRiskSounds) blocks.push({ type: "markdown", text: `Sound with a high claim risk: ${k}`, tone: "warn" });
  if (i.noStory) blocks.push({ type: "markdown", text: i.noStory, tone: "warn" });
  if (i.approveProblem) blocks.push({ type: "markdown", text: APPROVE_NO + i.approveProblem, tone: "warn" });
  const details = [i.version ? `Version: ${i.version}` : "", i.scriptCarried ?? ""].filter(Boolean);
  if (details.length) blocks.push({ type: "fold", title: "Details", blocks: details.map((t) => ({ type: "markdown", text: t })) });
  return { question: i.caption.trim() || i.id, blocks };
}
const problemOf = (p: Packet | null | undefined) => (p?.blocks ?? []).find((b) => b.type === "markdown" && b.text.startsWith(APPROVE_NO)) as { text: string } | undefined;

const about = (s: VideoState, id: string, what: string) => ({
  title: `${what}: ${s.items[id]?.caption || id}`,
  one: what,
  many: `${what} (several)`,
  label: "Video",
  name: s.items[id]?.caption || id,
  to: "the video page",
  ids: [["Video", id]] as [string, string][],
  noReassign: true,
});

export const wallgameVideo: Policy<VideoState> = {
  id: "wallgame-video",
  name: "Video review (Wall Game)",
  color: "#b0412e",
  on: ["video.item.waiting", "video.item.left"],
  emits: ["video.decided"],
  final: ["video.decided"],
  commands: {
    "video.apply": { actor: "videoapp", delivery: "at-most-once", what: "press Approve, Revise or Discard on the video page for your call", when: "After your call, once its Undo time is over" },
  },
  decider: { kind: "nil", predictor: { kind: "consult", criteria: "video-criteria.md" } },
  autoAllowed: false,
  answer: { action: { enum: [...ACTIONS], label: "Call" } },
  primary: ["action"],
  // No safe default (Antifeed PM, 2026-10-30): Approve posts a video publicly,
  // so only Wall Game Consult's Premove fills in a call.
  noDefault: "Approve posts the video publicly, so nothing is filled in without a prediction.",
  noAuthor: true,
  subjectLabel: "Video",
  notePlaceholder: "Note: goes to the Wall Game Director (needed for Revise and Discard)",
  undoUntilSent: UNDO_WORDS,
  validate: (call: Call, packet?: Packet | null) => {
    const note = String(call.note ?? "").trim();
    if (call.action === "revise" && !note) return "Write a note first: what should change?";
    if (call.action === "discard" && !note) return "Write a note first: why discard it?";
    if (note.length > NOTES_MAX) return `The note is too long: at most ${NOTES_MAX} characters.`;
    const p = call.action === "approve" ? problemOf(packet) : undefined;
    return p ? p.text : null;
  },
  init: { items: {}, card: {}, cardItem: {}, cardState: {}, cardHash: {}, apply: {} },
  reduce(state, e: Event) {
    const s: VideoState = { items: { ...state.items }, card: { ...state.card }, cardItem: { ...state.cardItem }, cardState: { ...state.cardState }, cardHash: { ...state.cardHash }, apply: { ...state.apply } };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    const open = (id: string): OutItem => ({ open: { subject: id, meta: { source: "Wall Game video page", raw: `http://127.0.0.1:${VIDEO_PORT}/review` }, packet: packetOf(s.items[id]) } });
    const hashes = (id: string): Hashes => ({ videoSha256: s.items[id]?.videoSha256 ?? "", copySha256: s.items[id]?.copySha256 ?? "" });
    switch (e.type) {
      case "video.item.waiting": {
        const id = e.subject!;
        const { sig: _sig, ...item } = d as VideoItemData;
        s.items[id] = { ...item, inQueue: true };
        const c = s.card[id];
        if (!c) {
          out.push(open(id));
          break;
        }
        if (s.cardState[c] === "decided") {
          // In review again after Nil's call (a new render, or an approval undone on the page): a call not sent yet does not go; a new card shows it.
          if (s.apply[c]) out.push({ cancel: s.apply[c], reason: "Not sent: the video is in review again as it is now, so a new card shows it." });
          delete s.card[id];
          out.push(open(id));
          break;
        }
        // A new render or new copy while the card is open: its next packet version.
        out.push({ repacket: { card: c, packet: packetOf(s.items[id]) } });
        break;
      }
      case "video.item.left": {
        const id = e.subject!;
        if (s.items[id]) s.items[id] = { ...s.items[id], inQueue: false };
        const c = s.card[id];
        if (!c) break;
        if (s.cardState[c] === "decided") {
          // Decided on the page (or gone) before the call went: it does not go.
          if (s.apply[c]) out.push({ cancel: s.apply[c], reason: "Not sent: the video left the review queue first (decided on its page)." });
          delete s.card[id];
        } else out.push({ withdraw: c, reason: "No longer in review." });
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        s.cardItem[e.card!] = e.subject!;
        s.cardState[e.card!] = "open";
        s.cardHash[e.card!] = hashes(e.subject!);
        break;
      case "card.packet": {
        const id = s.cardItem[e.card!];
        if (id) s.cardHash[e.card!] = hashes(id);
        break;
      }
      case "card.withdrawn": {
        const id = s.cardItem[e.card!];
        if (id && s.card[id] === e.card) delete s.card[id];
        delete s.cardState[e.card!];
        break;
      }
      case "card.decided": {
        const id = s.cardItem[e.card!];
        if (!id || d.generic) break;
        s.cardState[e.card!] = "decided";
        out.push({ emit: { type: "video.decided", subject: id, data: { call: d.call } } });
        const params = { id, action: d.call.action, notes: String(d.call.note ?? "").trim(), ...(s.cardHash[e.card!] ?? hashes(id)) };
        out.push({ issue: { type: "video.apply", card: e.card, subject: id, params, about: about(s, id, `Your ${WORD[d.call.action] ?? d.call.action} on the video page`) } });
        break;
      }
      case "card.undone": {
        // Only inside the Undo time: after the press the engine refuses the Undo (undoUntilSent).
        const id = s.cardItem[e.card!];
        s.cardState[e.card!] = "open";
        if (s.apply[e.card!]) out.push({ cancel: s.apply[e.card!] });
        if (id && s.card[id] && s.card[id] !== e.card) out.push({ withdraw: e.card!, reason: "A newer card shows this video." });
        else if (id && !s.items[id]?.inQueue) out.push({ withdraw: e.card!, reason: "No longer in review." });
        else if (id) s.card[id] = e.card!;
        break;
      }
      case "command.issued":
        if (d.type === "video.apply" && d.card) s.apply[d.card] = e.command!;
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        // Not sent (the video changed or left): the next read of the queue
        // opens a new card for a video still in review, with what it is now.
        for (const [c, k] of Object.entries(s.apply)) if (k === e.command) delete s.apply[c];
        break;
    }
    return { state: s, out };
  },
};

const errorOf = async (r: Response) => {
  const t = await r.text().catch(() => "");
  try {
    return String((JSON.parse(t) as { error?: string }).error ?? t);
  } catch {
    return t;
  }
};

// video.apply: the page's own route, with the hashes of what Nil saw and his
// note with the "(via Antifeed)" line. A 4xx
// is a failure card with the app's words; a 5xx or no answer "may have gone".
export async function videoApp(k: CommandRec, _ctx: RunContext): Promise<unknown> {
  const p = k.params as { id: string; action: string; notes: string; videoSha256: string; copySha256: string };
  const h = memberHeader(VIDEO_MEMBER);
  // The call goes only while the video still waits as Nil saw it.
  let items: { id: string; videoSha256: string; copySha256: string }[];
  try {
    const r = await fetch(`${videoUrl()}/api/review/queue`, { headers: h, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`GET /api/review/queue answered ${r.status}`);
    items = ((await r.json()) as { items?: typeof items }).items ?? [];
  } catch (err) {
    throw new Failed("the video page did not answer, so nothing was sent", (err as Error).message);
  }
  const it = items.find((x) => x.id === p.id);
  if (!it) return { notSent: NOT_SENT_GONE };
  if (it.videoSha256 !== p.videoSha256 || it.copySha256 !== p.copySha256) return { notSent: NOT_SENT_CHANGED };
  const word = WORD[p.action] ?? p.action;
  let r: Response;
  try {
    r = await fetch(`${videoUrl()}/api/review/${encodeURIComponent(p.id)}/${p.action}`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ notes: sentNotes(p.notes), videoSha256: p.videoSha256, copySha256: p.copySha256 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MaybeSent(`the video page gave no answer to your ${word}; look at its review queue`, (err as Error).message);
  }
  if (r.status >= 400 && r.status < 500) throw new Failed(`the video page refused it: ${await errorOf(r)}`, `POST /api/review/${p.id}/${p.action} answered ${r.status}`);
  if (!r.ok) throw new MaybeSent(`the video page gave no clear answer (${r.status}); look at its review queue`, `POST /api/review/${p.id}/${p.action} answered ${r.status}`);
  return { sent: p.action };
}

type Parts = {
  actors: Actor[];
  sources: { id: string; kind: string }[];
  events: Record<string, { from: string; what: string }>;
  policies: Policy[];
  run: Record<string, (k: CommandRec, ctx: RunContext) => unknown>;
  handlers: Record<string, Handler>;
};
export function videoParts(on = VIDEO_IN_ANTIFEED): Parts {
  if (!on) return { actors: [], sources: [], events: {}, policies: [], run: {}, handlers: {} };
  return {
    actors: [{ id: "videoapp", kind: "code", handler: "videoapp" }] as Actor[],
    sources: [{ id: "video", kind: "game-video" }],
    events: {
      "video.item.waiting": { from: "video", what: "a finished daily video that waits for your review on the video page" },
      "video.item.left": { from: "video", what: "a video that left the review queue: approved, revised, discarded or gone" },
      "video.decided": { from: "wallgame-video", what: "your review call on a video" },
    },
    policies: [wallgameVideo] as Policy[],
    run: { videoapp: videoApp },
    handlers: {},
  };
}
