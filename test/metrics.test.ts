import { afterAll, describe, expect, test } from "bun:test";
import { activeMs, calibrated, calibration, effective, noteOnly, weekly, weekOf, wilsonLower } from "../src/metrics";
import type { DecisionLine, Outcome } from "../src/types";
import { cleanup, engine, fileAndPrepare, MEMBER, tempDir } from "./helpers";

afterAll(cleanup);

let n = 0;
const line = (o: { at: string; shownAt?: string; outcome: Outcome | null; confidence?: number; by?: string; predictor?: string; policy?: string; imported?: boolean }): DecisionLine => ({
  id: `d_${n++}`, at: o.at, policy: o.policy ?? "triage", project: "isomux", card: `c_${n}`, version: 1,
  snapshot: { question: "", blocks: [], options: [], recommended: null, meta: { source: "", author: null, openedAt: "", raw: "" } },
  prediction: o.confidence === undefined ? null : { call: {}, confidence: o.confidence, why: "", against: "", by: (o.predictor ?? "agent:p#v1") as never, precedent: [] },
  call: {}, by: (o.by ?? "human:Nil") as never, outcome: o.outcome, note: "", shownAt: o.shownAt ?? null, secondsToDecide: null,
  ...(o.imported ? { imported: true } : {}),
});

describe("calibration", () => {
  test("bands count clean matches by a human, per predictor version", () => {
    const at = "2026-10-26T16:00:00Z";
    const ls = [
      line({ at, outcome: "matched", confidence: 0.95 }),
      line({ at, outcome: "edited", confidence: 0.92 }),
      line({ at, outcome: "matched", confidence: 0.75 }),
      line({ at, outcome: "matched", confidence: 0.95, predictor: "agent:p#v2" }),
      line({ at, outcome: null, confidence: 0.99, by: "agent:p#v1" }),
      line({ at, outcome: "matched", confidence: 0.99, imported: true }),
      line({ at, outcome: "unpredicted" }),
    ];
    const cal = calibration(ls, "triage");
    const v1 = cal.find((c) => c.predictor === "agent:p#v1")!;
    expect(v1.bands.map((b) => [b.label, b.matched, b.n])).toEqual([[">= 0.9", 1, 2], ["0.7-0.9", 1, 1], ["0.5-0.7", 0, 0], ["< 0.5", 0, 0]]);
    expect(cal.find((c) => c.predictor === "agent:p#v2")!.bands[0].n).toBe(1);
    const frozen = calibration(ls, "triage", { at, min: 0.9 })[0].bands.map((b) => b.frozen);
    expect(frozen).toEqual([true, false, false, false]);
  });

  test("X14: each code stand-in tier with a basis has its own row; Y15: the safe default has none", () => {
    const at = "2026-10-26T16:00:00Z";
    const why = (l: DecisionLine, w: string) => ((l.prediction!.why = w), l);
    const ls = [
      why(line({ at, outcome: "matched", confidence: 0, predictor: "code:standin" }), "No basis: none yet."),
      why(line({ at, outcome: "matched", confidence: 0.6, predictor: "code:standin" }), "3 of the 5 most similar past cards got this call."),
    ];
    // Y15: the safe default is never filled in, so it is no Premove: no row, no match rate, and it needed Nil.
    expect(calibration(ls, "triage").map((c) => [c.predictor, c.basis])).toEqual([["code:standin", "vote"]]);
    expect(weekly([ls[0]]).find((w) => w.policy === "all")).toMatchObject({ matched: 0, effective: 1, unpredicted: 1, matchRate: null });
  });

  test("X6: an edit that is only Nil's note is told apart", () => {
    const at = "2026-10-26T16:00:00Z";
    const a = line({ at, outcome: "edited", confidence: 0.8 });
    a.prediction!.call = { choice: "go", priority: "P1" };
    a.call = { choice: "go", priority: "P1", note: "ship it Friday" };
    const b = { ...a, call: { choice: "go", priority: "P2", note: "" } };
    const d = { ...a, snapshot: { ...a.snapshot, blocks: [{ type: "draft" as const, key: "reply", text: "Hi" }] }, call: { ...a.call, reply: "Hello" } };
    expect([noteOnly(a), noteOnly(b), noteOnly(d)]).toEqual([true, false, false]);
    expect(weekly([a, b]).find((w) => w.policy === "all")).toMatchObject({ effective: 2, changed: 2, noteOnly: 1 });
  });

  test("Wilson lower bound", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(47, 50)).toBeCloseTo(0.838, 2);
    expect(wilsonLower(50, 50)).toBeLessThan(1);
  });
});

describe("DPM and eDPM", () => {
  test("active time is the union of the spans, each capped at 5 minutes", () => {
    const ls = [
      line({ shownAt: "2026-10-26T16:00:00Z", at: "2026-10-26T16:00:30Z", outcome: "matched" }),
      line({ shownAt: "2026-10-26T16:00:20Z", at: "2026-10-26T16:01:00Z", outcome: "matched" }),
      line({ shownAt: "2026-10-26T15:00:00Z", at: "2026-10-26T16:20:00Z", outcome: "changed" }),
      line({ at: "2026-10-26T17:00:00Z", outcome: "edited" }),
    ];
    expect(activeMs(ls)).toBe(60_000 + 300_000);
  });

  test("weeks start on Monday in Pacific time; eDPM counts the effective calls, next to the match rate", () => {
    // Monday 2026-10-26 00:30 PT is 07:30 UTC; Sunday 23:30 PT is 06:30 UTC.
    expect(weekOf("2026-10-26T07:30:00Z")).toBe("2026-10-26");
    expect(weekOf("2026-10-26T06:30:00Z")).toBe("2026-10-19");
    const ls = [
      line({ shownAt: "2026-10-27T16:00:00Z", at: "2026-10-27T16:01:00Z", outcome: "matched", confidence: 0.9 }),
      line({ shownAt: "2026-10-27T16:01:00Z", at: "2026-10-27T16:02:00Z", outcome: "changed", confidence: 0.9 }),
      line({ shownAt: "2026-10-27T16:02:00Z", at: "2026-10-27T16:04:00Z", outcome: "edited", confidence: 0.9, policy: "design" }),
      line({ shownAt: "2026-10-27T16:04:00Z", at: "2026-10-27T16:05:00Z", outcome: null, by: "agent:p" }),
    ];
    const all = weekly(ls).find((w) => w.policy === "all")!;
    // The match has no earlier calls in its band, so it is unsure: all 3 needed Nil.
    expect(all).toMatchObject({ week: "2026-10-26", decisions: 3, effective: 3, changed: 2, unsure: 1, sureConfirms: 0, activeMinutes: 4 });
    expect(all.edpm).toBeCloseTo(0.75);
    expect(all.matchRate).toBeCloseTo(1 / 3);
    expect(weekly(ls).find((w) => w.policy === "triage")).toMatchObject({ decisions: 2, effective: 2, matchRate: 0.5 });
  });
});

// Effective decisions (Nil, 2026-10-26; DESIGN.md 15).
describe("effective decisions", () => {
  // n matches at 0.95, one a minute from 16:00 on 2026-10-27 (a Tuesday).
  const at = (i: number) => new Date(Date.parse("2026-10-27T16:00:00Z") + i * 60_000).toISOString();
  const run = (n: number, o: { predictor?: string; policy?: string; from?: number } = {}) =>
    Array.from({ length: n }, (_, i) => line({ at: at((o.from ?? 0) + i), outcome: "matched", confidence: 0.95, predictor: o.predictor, policy: o.policy }));
  const all = (ls: DecisionLine[]) => weekly(ls).find((w) => w.policy === "all")!;

  test("changed, edited and no Premove are effective; a sure confirm is not", () => {
    const sure = run(35);
    const ls = [
      ...sure,
      // In another band, so they do not touch the 0.95 band's record.
      line({ at: at(40), outcome: "changed", confidence: 0.8 }),
      line({ at: at(41), outcome: "edited", confidence: 0.8 }),
      line({ at: at(42), outcome: "unpredicted" }),
      line({ at: at(43), outcome: "matched", confidence: 0.95 }),
      line({ at: at(44), outcome: "matched", confidence: 0.6 }),
    ];
    const cal = calibrated(ls);
    expect(ls.slice(35).map((l) => effective(l, cal))).toEqual([true, true, true, false, true]);
    // The first 35 had fewer than 35 earlier matches in their band: unsure.
    expect(all(ls)).toMatchObject({ decisions: 40, matched: 37, changed: 2, unpredicted: 1, unsure: 36, sureConfirms: 1, effective: 39 });
  });

  test("the 35-of-35 edge: 34 clean matches give 89.8%, 35 give 90.1%", () => {
    expect(wilsonLower(34, 34)).toBeLessThan(0.9);
    expect(wilsonLower(35, 35)).toBeGreaterThanOrEqual(0.9);
    const ls = run(36);
    const cal = calibrated(ls);
    expect(cal.get(ls[34].id)).toBeLessThan(0.9);
    expect(cal.get(ls[35].id)).toBeGreaterThanOrEqual(0.9);
    expect(ls.map((l) => effective(l, cal)).filter((x) => !x)).toHaveLength(1);
    // One miss among the earlier calls keeps the band under 0.9.
    const miss = [...run(35), line({ at: at(35), outcome: "edited", confidence: 0.95 }), line({ at: at(36), outcome: "matched", confidence: 0.95 })];
    miss[3].outcome = "edited";
    expect(effective(miss[36], calibrated(miss))).toBe(true);
  });

  test("before it: a call keeps the verdict it had when Nil made it", () => {
    const ls = run(36);
    const first = calibrated(ls);
    // Later misses in the band do not make the 36th call effective again, and
    // later matches do not make the earlier calls sure.
    const later = [...ls, ...Array.from({ length: 10 }, (_, i) => line({ at: at(100 + i), outcome: "changed", confidence: 0.95 })), ...run(40, { from: 200 })];
    const cal = calibrated(later);
    for (const l of ls) expect(cal.get(l.id)).toBe(first.get(l.id)!);
    // Calls at the same time are not before each other.
    const same = [...run(35), ...Array.from({ length: 2 }, () => line({ at: at(50), outcome: "matched", confidence: 0.95 }))];
    const c2 = calibrated(same);
    expect([c2.get(same[35].id), c2.get(same[36].id)]).toEqual([wilsonLower(35, 35), wilsonLower(35, 35)]);
    // A past week's numbers stay as they were after a later week adds calls.
    const week1 = weekly(ls).filter((w) => w.week === "2026-10-26");
    const next = run(40, { from: 7 * 24 * 60 });
    expect(weekly([...ls, ...next]).filter((w) => w.week === "2026-10-26")).toEqual(week1);
  });

  test("rows stay apart: another predictor, an informed row, a stand-in tier, another policy or band lend no record", () => {
    const informed = run(35);
    for (const l of informed) l.prediction!.informed = true;
    const lenders = [...informed, ...run(35, { from: 40, predictor: "agent:p#v2" }), ...run(35, { from: 80, policy: "design" }), ...run(35, { from: 120, predictor: "code:standin" })];
    for (const l of lenders.slice(105)) l.prediction!.why = "3 of the 5 most similar past cards got this call.";
    const plain = line({ at: at(500), outcome: "matched", confidence: 0.95 });
    const lowBand = line({ at: at(501), outcome: "matched", confidence: 0.8, policy: "design" });
    const cal = calibrated([...lenders, plain, lowBand]);
    expect(cal.get(plain.id)).toBe(0);
    expect(cal.get(lowBand.id)).toBe(0);
    expect([effective(plain, cal), effective(lowBand, cal)]).toEqual([true, true]);
    // Each lender row reaches 0.9 on its own next call.
    const own = line({ at: at(502), outcome: "matched", confidence: 0.95, policy: "design" });
    expect(effective(own, calibrated([...lenders, own]))).toBe(false);
  });

  test("the weeks are the same after a restart, and an undone call is out", async () => {
    const dir = tempDir();
    const a = engine(dir);
    a.fake.answer = () => ({ confidence: 0.95 });
    for (let i = 0; i < 37; i++) {
      const c = await fileAndPrepare(a.e, `t${i}`);
      const shownAt = new Date(a.clock.t).toISOString();
      a.clock.t += 20_000;
      a.e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P2" }, shownAt });
    }
    const last = [...a.e.cards.values()].find((c) => c.subject === "t36")!;
    a.e.undo(MEMBER, last.id);
    const w = weekly(a.e.decisions.live());
    expect(w.find((x) => x.policy === "all")).toMatchObject({ decisions: 36, matched: 36, sureConfirms: 1, effective: 35 });
    const b = engine(dir, { clock: a.clock });
    await b.e.settle();
    expect(weekly(b.e.decisions.live())).toEqual(w);
  });
});
