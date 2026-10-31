import { afterAll, describe, expect, test } from "bun:test";
import { calibration, weekly } from "../src/metrics";
import { loopLines } from "../src/seed-loop";
import { cleanup, engine, fakeAgent, fileAndPrepare, MEMBER, tempDir } from "./helpers";

afterAll(cleanup);

describe("decider timeout", () => {
  test("a run past its timeout gets an aborted signal", async () => {
    const fake = fakeAgent();
    fake.answer = () => "hang";
    const { e } = engine(tempDir(), { fake, predictTimeoutMs: 50 });
    await fileAndPrepare(e);
    expect(fake.signals[0]?.aborted).toBe(true);
  });
});

describe("the loop app seed", () => {
  const items = [
    { taskId: "t1", task: { title: "Fix the login button", description: "It overlaps.", priority: "P2", createdBy: "W", createdAt: 1 }, proposal: { choice: "go", priority: "P2", why: "small" }, proposedAt: Date.parse("2026-10-19T00:00:00Z"), decision: { choice: "go", priority: "P1", note: "", decidedAt: Date.parse("2026-10-19T01:00:00Z") } },
    { taskId: "t2", task: { title: "Old idea", priority: "P3", createdAt: 1 }, proposal: { choice: "go", priority: "P3", why: "x" }, proposedAt: 0, decision: { choice: "rewrite", priority: null, note: "plainer", decidedAt: Date.parse("2026-10-20T00:00:00Z") } },
  ];
  test("imported once; precedent without the Curator's proposal; out of calibration and DPM", async () => {
    const { e } = engine(tempDir());
    const lines = loopLines(items, "triage", "isomux");
    expect(e.importPrecedent("triage", "isomux-loop", lines).duplicate).toBe(false);
    expect(e.importPrecedent("triage", "isomux-loop", lines).duplicate).toBe(true);
    const p = e.decisions.precedent("triage");
    expect(p.map((l) => l.id)).toEqual(["d_loop_t2_" + items[1].decision.decidedAt, "d_loop_t1_" + items[0].decision.decidedAt]);
    expect(p[0].generic).toEqual({ kind: "rewrite" });
    expect("proposal" in p[1].snapshot).toBe(false);
    expect((e.decisions.live()[0].snapshot as { proposal?: unknown }).proposal).toEqual({ choice: "go", priority: "P2", why: "small" });
    expect(calibration(e.decisions.live(), "triage")).toEqual([]);
    expect(weekly(e.decisions.live())).toEqual([]);
    expect(() => e.importPrecedent("triage", "other", [{ ...lines[0], imported: undefined }])).toThrow(/imported line/);
  });
});

describe("slice 5 fixes", () => {
  test("every card.predicted names its decider, a failed run too", async () => {
    const fake = fakeAgent();
    fake.answer = () => "throw";
    const { e } = engine(tempDir(), { fake });
    await fileAndPrepare(e);
    expect(e.log.all().find((x) => x.type === "card.predicted")!.data).toMatchObject({ prediction: { by: "code:standin" }, decider: "nil+agent:fake-triage", error: "predictor broke" });
  });

  test("precedent is newest first by time, also for lines imported later", async () => {
    const { e } = engine(tempDir());
    const c = await fileAndPrepare(e);
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1" } });
    e.importPrecedent("triage", "isomux-loop", loopLines(items(), "triage", "isomux"));
    expect(e.decisions.precedent("triage")[0].card).toBe(c.id);
  });
});

function items() {
  return [{ taskId: "t9", task: { title: "Old", priority: "P3", createdAt: 1 }, proposal: {}, proposedAt: 0, decision: { choice: "go", priority: "P2", note: "", decidedAt: Date.parse("2026-10-01T00:00:00Z") } }];
}
