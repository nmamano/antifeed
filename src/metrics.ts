// Calibration per policy and predictor version, and weekly DPM / eDPM
// (DESIGN.md sections 5 and 15).

import { EFFECTIVE_MIN_CONFIDENCE } from "./config";
import { standinBasis } from "./standin";
import type { Block, DecisionLine } from "./types";

// Wilson score lower bound at 95% (Proto 3 ladder.ts wilsonLower).
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

export const BANDS = [
  { label: ">= 0.9", lo: 0.9, hi: Infinity },
  { label: "0.7-0.9", lo: 0.7, hi: 0.9 },
  { label: "0.5-0.7", lo: 0.5, hi: 0.7 },
  { label: "< 0.5", lo: -Infinity, hi: 0.5 },
] as const;

export type Band = { label: string; matched: number; n: number; lower: number; frozen: boolean };
// basis: for the code stand-in, which tier made it (vote, author, none), so
// each tier has its own row.
export type Calibration = { policy: string; predictor: string; basis: string | null; bands: Band[]; switchedAt: string | null };

// A safe default is never filled in as Nil's call (DESIGN.md 13.8): a line
// with one counts as a line with no Premove, in calibration and in the weeks.
export const unfilled = (l: DecisionLine) => l.prediction?.by === "code:standin" && standinBasis(l.prediction) === "none";
const outcomeOf = (l: DecisionLine) => (unfilled(l) ? "unpredicted" : l.outcome);

// Lines that count: by a human, with a prediction, not imported. Clean
// matches only count as matched.
const counted = (l: DecisionLine) => l.by.startsWith("human:") && !!l.prediction && !l.imported && l.outcome !== null && outcomeOf(l) !== "unpredicted";
// A line's calibration row: its predictor version; an informed prediction
// carries Nil's own view, so it has its own row (DESIGN.md 13.1); each code
// stand-in tier has its own row.
const rowOf = (l: DecisionLine) => `${l.prediction!.by}${l.prediction!.informed ? " (informed)" : ""}|${l.prediction!.by === "code:standin" ? standinBasis(l.prediction!) : ""}`;
const bandOf = (confidence: number) => BANDS.findIndex((b) => confidence >= b.lo && confidence < b.hi);

// After a switch to threshold at `min`, cards at or above min stop reaching
// Nil, so those bands are frozen.
export function calibration(lines: readonly DecisionLine[], policy: string, sw: { at: string; min: number } | null = null): Calibration[] {
  const byPredictor = new Map<string, DecisionLine[]>();
  for (const l of lines) {
    if (l.policy !== policy || !counted(l)) continue;
    const key = rowOf(l);
    byPredictor.set(key, [...(byPredictor.get(key) ?? []), l]);
  }
  return [...byPredictor].map(([key, ls]) => ({
    policy,
    predictor: key.split("|")[0],
    basis: key.split("|")[1] || null,
    switchedAt: sw?.at ?? null,
    bands: BANDS.map((b, i) => {
      const inBand = ls.filter((l) => bandOf(l.prediction!.confidence) === i);
      const matched = inBand.filter((l) => l.outcome === "matched").length;
      return { label: b.label, matched, n: inBand.length, lower: wilsonLower(matched, inBand.length), frozen: sw !== null && b.hi > sw.min };
    }),
  }));
}

// The calibrated confidence of each counted line's Premove (DESIGN.md 15):
// the safe estimate of its band, in its own policy and row, over the counted
// lines decided before it. A band with no earlier lines gives 0. "Before"
// keeps a call's verdict as it was when Nil made it: later calls never change it.
export function calibrated(lines: readonly DecisionLine[]): Map<string, number> {
  const out = new Map<string, number>();
  const tally = new Map<string, { matched: number; n: number }>();
  const ls = lines.filter(counted).sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 0; i < ls.length; ) {
    // Lines with the same time are not before each other.
    let j = i;
    while (j < ls.length && ls[j].at === ls[i].at) j++;
    const group = ls.slice(i, j);
    const keyOf = (l: DecisionLine) => `${l.policy}|${rowOf(l)}|${bandOf(l.prediction!.confidence)}`;
    for (const l of group) {
      const t = tally.get(keyOf(l));
      out.set(l.id, t ? wilsonLower(t.matched, t.n) : 0);
    }
    for (const l of group) {
      const t = tally.get(keyOf(l)) ?? { matched: 0, n: 0 };
      tally.set(keyOf(l), { matched: t.matched + (l.outcome === "matched" ? 1 : 0), n: t.n + 1 });
    }
    i = j;
  }
  return out;
}

// An effective decision (Nil, 2026-10-26; DESIGN.md 15): one that needed
// Nil. Nil changed or edited the Premove, or the card had no Premove (or a
// safe default, never filled in), or he confirmed a Premove whose
// calibrated confidence was under EFFECTIVE_MIN_CONFIDENCE.
export function effective(l: DecisionLine, cal: Map<string, number>): boolean {
  const o = outcomeOf(l);
  if (o === "edited" || o === "changed" || o === "unpredicted") return true;
  return o === "matched" && (cal.get(l.id) ?? 0) < EFFECTIVE_MIN_CONFIDENCE;
}

export const CAP_MS = 5 * 60_000;

// Monday 00:00 in Nil's time zone, as a date string: the week a time is in.
export function weekOf(at: string, timeZone = "America/Los_Angeles"): string {
  const t = Date.parse(at);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) - back);
  return new Date(local).toISOString().slice(0, 10);
}

export type Week = {
  week: string; policy: string | "all"; decisions: number; effective: number; activeMinutes: number; dpm: number; edpm: number; matchRate: number | null;
  matched: number;
  // The parts of effective: calls Nil changed or edited (of them, noteOnly:
  // equal to the Premove but for a note he added), calls with no Premove,
  // and matches whose calibrated confidence was under the minimum.
  changed: number;
  noteOnly: number;
  unpredicted: number;
  unsure: number;
  // Matches at the minimum or more: not effective, candidates for a threshold.
  sureConfirms: number;
};

function draftTexts(blocks: Block[], out: Record<string, string> = {}): Record<string, string> {
  for (const b of blocks) {
    if (b.type === "draft") out[b.key] = b.text;
    else if (b.type === "fold") draftTexts(b.blocks, out);
  }
  return out;
}
// An edited call whose only edit is Nil's note: every field and draft as the Premove had it.
export function noteOnly(l: DecisionLine): boolean {
  if (outcomeOf(l) !== "edited" || !l.prediction) return false;
  const drafts = draftTexts(l.snapshot.blocks ?? []);
  const norm = (v: unknown) => (v === undefined || v === "" ? null : v);
  const keys = new Set([...Object.keys(l.prediction.call), ...Object.keys(l.call)].filter((k) => k !== "note"));
  return [...keys].every((k) => (k in drafts ? l.call[k] === undefined || l.call[k] === drafts[k] : norm(l.prediction!.call[k]) === norm(l.call[k])));
}

// Active time: the union of the spans from shownAt to the decision, each
// capped at 5 minutes. A line with no shownAt adds no time.
export function activeMs(lines: readonly DecisionLine[]): number {
  const spans = lines
    .filter((l) => l.shownAt)
    .map((l) => {
      const end = Date.parse(l.at);
      return [Math.max(Date.parse(l.shownAt!), end - CAP_MS), end] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s[0], s[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

// Weekly DPM and eDPM per policy and in total, from Nil's live decisions,
// computed again at each read. eDPM counts the effective calls (DESIGN.md
// 15); the match rate shows next to it (THESIS: a worse predictor raises eDPM).
export function weekly(lines: readonly DecisionLine[]): Week[] {
  const human = lines.filter((l) => l.by.startsWith("human:") && !l.imported);
  const cal = calibrated(human);
  const groups = new Map<string, DecisionLine[]>();
  for (const l of human) {
    const w = weekOf(l.at);
    for (const key of [`${w}|${l.policy}`, `${w}|all`]) groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups]
    .map(([key, ls]) => {
      const [week, policy] = key.split("|");
      const minutes = activeMs(ls) / 60_000;
      const count = (f: (l: DecisionLine) => boolean) => ls.filter(f).length;
      const effectiveN = count((l) => effective(l, cal));
      const matched = count((l) => outcomeOf(l) === "matched");
      const sure = count((l) => outcomeOf(l) === "matched" && !effective(l, cal));
      const predicted = ls.filter((l) => outcomeOf(l) && outcomeOf(l) !== "unpredicted");
      return {
        week,
        policy,
        decisions: ls.length,
        effective: effectiveN,
        matched,
        changed: count((l) => outcomeOf(l) === "edited" || outcomeOf(l) === "changed"),
        noteOnly: count(noteOnly),
        unpredicted: count((l) => outcomeOf(l) === "unpredicted"),
        unsure: matched - sure,
        sureConfirms: sure,
        activeMinutes: Math.round(minutes * 10) / 10,
        dpm: minutes ? ls.length / minutes : 0,
        edpm: minutes ? effectiveN / minutes : 0,
        matchRate: predicted.length ? predicted.filter((l) => outcomeOf(l) === "matched").length / predicted.length : null,
      };
    })
    .sort((a, b) => a.week.localeCompare(b.week) || a.policy.localeCompare(b.policy));
}
