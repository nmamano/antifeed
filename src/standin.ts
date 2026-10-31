// The code stand-in (DESIGN.md 13.1): the last fallback when the consult
// agent and the claude -p stand-in both gave nothing, so a decision card
// never goes to Nil with no Premove. It never decides.

import { lineText, packetText } from "./predictor";
import type { Call, Card, DecisionLine, Policy, Prediction, StandinBasis } from "./types";
import { checkCall } from "./validate";

// What kind of stand-in a code vote is, for the page.
// The tier of a code stand-in: stored as data (standin.basis) since 2026-10-25;
// older lines are read from the start of their reason.
export const standinBasis = (p: { why: string; standin?: { basis?: StandinBasis } }): StandinBasis =>
  p.standin?.basis ?? (p.why.startsWith("No basis") ? "none" : p.why.startsWith("The author's pick") ? "author" : "vote");

const VOTE_LINES = 10;
// A value as the page says it (client.js VALUE_WORDS), for a reason's words.
const VALUE_WORDS: Record<string, string> = { hold: "on hold", "file-task": "file as a task" };
const label = (c: Call) => Object.values(c).filter((v) => v != null).map((v) => VALUE_WORDS[String(v)] ?? String(v)).join(" ") || "no fields";
const MIN_LINES = 3;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n || 1);
}

// The choice fields of a call (no text, no note, no draft text): what a
// vote over past cards can carry, since words belong to one card.
function fieldsOf(policy: Policy, call: Call): Call {
  const out: Call = {};
  for (const [k, f] of Object.entries(policy.answer ?? {})) if (k !== "note" && f.enum && k in call) out[k] = call[k] ?? null;
  return out;
}
// Every answer field of an option's fill, its words too (no note): an ask's
// option is a reply with its own words (slice 7 walk, 2026-10-26).
function answerOf(policy: Policy, call: Call): Call {
  const out: Call = {};
  for (const k of Object.keys(policy.answer ?? {})) if (k !== "note" && k in call) out[k] = call[k] ?? null;
  return out;
}
// A stand-in's call must pass the check as Nil's call does; a tier whose
// call does not (a vote for "reply" has no words) gives way to the next.
const fits = (policy: Policy, card: Card, call: Call) => !(checkCall(policy.answer ?? {}, call, undefined, card.packet) ?? policy.validate?.(call));

export function codeVote(policy: Policy, card: Card, precedent: DecisionLine[]): Omit<Prediction, "standin"> & { basis: StandinBasis } {
  // No safe default: no vote either, only the Predictor fills in a call.
  if (policy.noDefault) return safeDefault(policy);
  const base = { by: "code:standin" as const, against: "", precedent: [] as string[] };
  const lines = precedent.filter((l) => !l.generic);
  if (card.packet && lines.length >= MIN_LINES) {
    const me = words(packetText(card.packet, card.meta));
    const near = lines
      .map((l) => ({ l, s: overlap(me, words(lineText(l))) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, VOTE_LINES)
      .map((x) => x.l);
    const votes = new Map<string, { call: Call; n: number }>();
    for (const l of near) {
      const call = fieldsOf(policy, l.call);
      const key = JSON.stringify(call);
      votes.set(key, { call, n: (votes.get(key)?.n ?? 0) + 1 });
    }
    // A vote carries no words. A vote for a call that needs them ("reply")
    // takes them from the author's pick when the pick makes the same call
    // (walk round 3: option A's words are no one's pick, and the vote does
    // not back them). When the most voted call cannot be made whole, there
    // is no basis: a less voted call would go against the vote (PM, walk of
    // round 3, 2026-10-26).
    const pick = (card.packet?.options ?? []).find((x) => x.id === card.packet?.recommended);
    const whole = (v: { call: Call; n: number }) => {
      if (fits(policy, card, v.call)) return { ...v, from: null };
      const ok = pick && JSON.stringify(fieldsOf(policy, pick.fill)) === JSON.stringify(v.call) && fits(policy, card, answerOf(policy, pick.fill));
      return ok ? { call: answerOf(policy, pick!.fill), n: v.n, from: pick! } : null;
    };
    const ranked = [...votes.values()].sort((a, b) => b.n - a.n);
    // Calls tied at the most votes are all the vote's call.
    const most = ranked.filter((v) => v.n === ranked[0].n);
    const top = most.map(whole).find((v) => v !== null);
    if (!top)
      return safeDefault(policy, `No basis: ${most[0].n} of the ${near.length} most similar past cards got ${label(most[0].call)}, but a vote cannot fill that call whole for this card, and ${pick ? "the author's pick is another call" : noPick(policy)}.`);
    const second = ranked.find((v) => JSON.stringify(v.call) !== JSON.stringify(fieldsOf(policy, top.call)));
    return {
      ...base,
      call: top.call,
      confidence: top.n / near.length,
      why: top.from
        ? `${top.n} of the ${near.length} most similar past cards got ${label(fieldsOf(policy, top.call))}. The words are the author's pick (option ${top.from.id.toUpperCase()}): the number backs ${label(fieldsOf(policy, top.call))}, not the words.`
        : `${top.n} of the ${near.length} most similar past cards got this call.`,
      against: second ? `${second.n} of them got ${label(second.call)}.` : "Every similar past card got this call, but a vote reads only the words of the card.",
      precedent: near.map((l) => l.id),
      basis: "vote",
    };
  }
  const opts = card.packet?.options ?? [];
  const pick = opts.find((o) => o.id === card.packet?.recommended);
  if (pick && fits(policy, card, answerOf(policy, pick.fill)))
    return { ...base, call: answerOf(policy, pick.fill), confidence: 0, why: lines.length ? "The author's pick: there are too few past calls to vote with yet." : "The author's pick: there are no past calls to vote with yet.", against: "The author's pick is the author's view, not a prediction of your call.", basis: "author" };
  return safeDefault(policy, lines.length ? `No basis: there are too few past calls to vote with yet, and ${noPick(policy)}.` : undefined);
}

// The end of a no-basis line: a card with no author gets no pick, so what is
// missing is the consult agent's prediction (slice 8 walk).
const noPick = (policy: Policy) => (policy.noAuthor ? "no prediction came from the consult agent" : "the author named no pick");

// No basis: the policy's safe default (DESIGN.md 13.7), never an arbitrary
// value and never an empty call. The load check has checked the fallback.
// A policy with noDefault has none: its call is empty, and the page fills in nothing.
export function safeDefault(policy: Policy, why = policy.noDefault ? `No basis: ${noPick(policy)}. ${policy.noDefault}` : `No basis: you have made no calls on this kind of card yet, and ${noPick(policy)}.`): Omit<Prediction, "standin"> & { basis: StandinBasis } {
  return { by: "code:standin", precedent: [], call: { ...(policy.fallback ?? {}) }, confidence: 0, why, against: "Nothing here predicts your call; decide from the packet.", basis: "none" };
}
