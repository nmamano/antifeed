import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_UNDO_MS, EngineError } from "../src/engine";
import { EventLog } from "../src/log";
import type { Policy } from "../src/types";
import fakeDef from "./fixtures/isomux/policies";
import { engine, fakeAgent, fileAndPrepare, MEMBER, packet, project, tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const types = (e: { log: { all(): readonly { type: string }[] } }) => e.log.all().map((x) => x.type).filter((t) => t !== "batch.end");

describe("triage flow", () => {
  test("a filed task becomes a card with a Premove; Nil's call emits the answer and issues the apply", async () => {
    const { e, fake } = engine(tempDir());
    const card = await fileAndPrepare(e);
    expect(card.state).toBe("open");
    expect(card.prediction?.call).toEqual({ choice: "go", priority: "P2" });
    // The predictor sees the packet without the author's recommended mark.
    expect(fake.calls).toHaveLength(1);

    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1", note: "" }, shownAt: "2026-10-26T15:59:50Z" });
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    expect(apply).toMatchObject({ actor: "curator", state: "issued", delivery: "at-least-once" });
    expect(types(e)).toContain("triage.decided");
    const line = e.decisions.live()[0];
    expect(line).toMatchObject({ policy: "triage", outcome: "edited", by: "human:Nil", secondsToDecide: 10 });
    expect(line.prediction?.why).toBe("fits the goals");

    e.startCommand(apply.id);
    expect(() => e.startCommand(apply.id)).toThrow(EngineError);
    e.commandResult(apply.id, { ok: true });
    expect(e.commandResult(apply.id, { ok: true }).duplicate).toBe(true);
    expect(e.commands.get(apply.id)!.state).toBe("done");
  });

  test("each derived event is in the same batch as its input, and the batch ends with batch.end", async () => {
    const dir = tempDir();
    const { e } = engine(dir);
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const filed = lines.find((l) => l.type === "board.task.filed");
    const batch = lines.filter((l) => l.batch === filed.batch).map((l) => l.type);
    expect(batch).toEqual(["board.task.filed", "card.opened", "command.issued", "batch.end"]);
  });

  test("a closed task withdraws its open card; a changed task re-prepares it", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.changed", subject: "t1", data: { title: "Fix the login button on iOS", priority: "P2" } });
    expect(e.cards.get(card.id)!.changedAfterPacket).toBe(true);
    const again = [...e.commands.values()].filter((k) => k.type === "triage.prepare" && k.card === card.id);
    expect(again).toHaveLength(2);
    e.postPacket({ command: again[1].id, packet: packet("v2"), meta: { raw: "board:t1" } });
    await e.settle();
    expect(e.cards.get(card.id)).toMatchObject({ version: 2, state: "open" });
    expect(e.cards.get(card.id)!.changedAfterPacket).toBeUndefined();
    // Nil's call names the version he saw.
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } })).toThrow(/version 2/);
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.closed", subject: "t1" });
    expect(e.cards.get(card.id)!.state).toBe("withdrawn");
  });

  test("rewrite asks the author again; refine needs an option", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { note: "" }, generic: { kind: "rewrite" } })).toThrow(/needs a note/);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: {}, generic: { kind: "refine", option: "x" } })).toThrow(/option/);
    e.decide(MEMBER, card.id, { version: 1, call: { note: "say what breaks first" }, generic: { kind: "rewrite" } });
    expect(e.cards.get(card.id)!.state).toBe("preparing");
    expect(e.decisions.live()[0].outcome).toBe("changed");
    const k = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    expect(k.params).toEqual({ taskId: "t1", revise: "say what breaks first" });
  });

  test("calls are checked against the answer schema and the policy's own check", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "ship" } })).toThrow(/choice must be one of/);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: null } })).toThrow(/needs a priority/);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1", owner: "x" } })).toThrow(/not a field/);
    expect(() => e.decide("", card.id, { version: 1, call: { choice: "backlog", priority: null } })).toThrow(/member id/);
  });
});

describe("undo", () => {
  test("Undo before delivery cancels the apply; after delivery the command stays and the card reopens", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P2" } });
    const k1 = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    e.undo(MEMBER, card.id);
    expect(e.commands.get(k1.id)!.state).toBe("cancelled");
    expect(e.cards.get(card.id)!.state).toBe("open");
    expect(e.decisions.live()).toHaveLength(0);

    e.decide(MEMBER, card.id, { version: 1, call: { choice: "backlog", priority: null } });
    const k2 = [...e.commands.values()].filter((k) => k.type === "triage.apply").at(-1)!;
    e.delivered(k2.id);
    e.undo(MEMBER, card.id);
    expect(e.commands.get(k2.id)!.state).toBe("delivered");
    expect(e.cards.get(card.id)!.state).toBe("open");
  });
});

describe("deciders", () => {
  test("every policy starts as nil, even when the file names threshold; only Nil's event switches it", async () => {
    const fake = fakeAgent();
    fake.answer = () => ({ confidence: 0.99 });
    const { e } = engine(tempDir(), { fake });
    expect(e.deciderOf("triage").config).toEqual({ kind: "nil", predictor: { kind: "agent", model: "fake", criteria: "criteria.md" } });
    const c1 = await fileAndPrepare(e, "t1");
    expect(c1.state).toBe("open");

    expect(() => e.setDecider(MEMBER, "triage", { kind: "threshold", agent: { kind: "agent", model: "other", criteria: "x" }, min: 0.5 })).toThrow(/file's agent/);
    expect(() => e.setDecider(MEMBER, "triage", { kind: "code", handler: "x" })).toThrow();
    e.setDecider(MEMBER, "triage", { kind: "threshold", agent: { kind: "agent", model: "fake", criteria: "criteria.md" }, min: 0.95 });
    const c2 = await fileAndPrepare(e, "t2");
    expect(c2.state).toBe("decided");
    expect(c2.decision?.by).toBe("agent:predictor@fake#abc123");
    // An agent's call is not precedent and has no outcome.
    expect(e.decisions.live().find((l) => l.card === c2.id)!.outcome).toBeNull();
    expect(e.decisions.precedent("triage")).toHaveLength(0);

    // Nil's Undo brings the agent's call back as the prediction.
    e.undo(MEMBER, c2.id);
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "backlog", priority: null } });
    expect(e.decisions.live().find((l) => l.card === c2.id)).toMatchObject({ by: "human:Nil", outcome: "changed" });
  });

  test("a policy with autoAllowed false never leaves nil", () => {
    const def = { ...fakeDef, policies: [{ ...fakeDef.policies[0], autoAllowed: false }] };
    const { e } = engine(tempDir(), { projects: [project(def)] });
    expect(() => e.setDecider(MEMBER, "triage", { kind: "threshold", agent: { kind: "agent", model: "fake", criteria: "criteria.md" }, min: 0.9 })).toThrow(/autoAllowed/);
  });

  test("a predictor that fails or hangs: the card goes to the queue with the code stand-in", async () => {
    const fake = fakeAgent();
    fake.answer = () => "throw";
    const { e } = engine(tempDir(), { fake, predictTimeoutMs: 50 });
    const c = await fileAndPrepare(e, "t1");
    expect(c).toMatchObject({ state: "open", prediction: { by: "code:standin", standin: { predictorError: "predictor broke" } } });
    fake.answer = () => "hang";
    const c2 = await fileAndPrepare(e, "t2");
    expect(c2).toMatchObject({ state: "open", prediction: { by: "code:standin", standin: { predictorError: "no answer in 50 ms" } } });
    // Counted against the stand-in, on its own calibration row.
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "go", priority: "P1" } });
    expect(e.decisions.live().at(-1)!).toMatchObject({ outcome: "changed", prediction: { by: "code:standin", call: { choice: "backlog", priority: null } } });
  });
});

describe("replay", () => {
  test("a restart rebuilds the same state and sends nothing", async () => {
    const dir = tempDir();
    const a = engine(dir);
    const card = await fileAndPrepare(a.e);
    a.e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const before = a.e.log.all().length;

    const b = engine(dir, { clock: a.clock });
    await b.e.settle();
    expect(b.fake.calls).toHaveLength(0);
    expect(b.e.state("triage")).toEqual(a.e.state("triage"));
    expect([...b.e.cards.values()]).toEqual([...a.e.cards.values()]);
    expect([...b.e.commands.values()]).toEqual([...a.e.commands.values()]);
    expect(b.e.replayDiffs).toEqual([]);
    // The restart adds only policies.loaded and its batch.end.
    expect(b.e.log.all().slice(before).map((x) => x.type)).toEqual(["policies.loaded", "batch.end"]);
  });

  test("a card left in predicting gets a new predictor run after a restart", async () => {
    const dir = tempDir();
    const fake = fakeAgent();
    fake.answer = () => "hang";
    const a = engine(dir, { fake, predictTimeoutMs: 60_000 });
    a.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    const k = [...a.e.commands.values()][0];
    a.e.postPacket({ command: k.id, packet: packet(), meta: { raw: "board:t1" } });
    expect([...a.e.cards.values()][0].state).toBe("predicting");

    const b = engine(dir);
    await b.e.settle();
    expect(b.fake.calls).toHaveLength(1);
    expect([...b.e.cards.values()][0].state).toBe("open");
  });

  test("changed reducer code shows as replay differences and sends nothing", async () => {
    const dir = tempDir();
    const a = engine(dir);
    a.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    const quiet: Policy = { ...fakeDef.policies[0], reduce: (s) => ({ state: s }) };
    const b = engine(dir, { projects: [project({ ...fakeDef, policies: [quiet] })] });
    expect(b.e.replayDiffs.length).toBeGreaterThan(0);
    expect(b.e.replayDiffs[0]).toMatchObject({ policy: "triage", expected: [] });
    // The commands the old code issued are still the log's; none is new.
    expect([...b.e.commands.values()]).toHaveLength(1);
  });

  test("a wake survives a restart and fires late with the real time", async () => {
    const dir = tempDir();
    const clock = { t: Date.parse("2026-10-26T16:00:00Z") };
    const a = engine(dir, { clock });
    // triage.apply has a one-hour timeout: decide, then restart past it.
    const card = await fileAndPrepare(a.e);
    a.e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
    expect(a.e.wakes.size).toBe(1);
    clock.t += 2 * 3_600_000;
    const b = engine(dir, { clock });
    expect(b.e.dueWakes()).toHaveLength(1);
    b.e.fireWakes();
    await b.e.settle();
    const tick = b.e.log.all().find((x) => x.type === "clock.tick")!;
    expect(tick.at).toBe(new Date(clock.t).toISOString());
    const failed = [...b.e.cards.values()].find((c) => c.policy === "command-failed")!;
    expect(failed.packet?.question).toContain("no result before its timeout");
    expect(engine(dir, { clock }).e.replayDiffs).toEqual([]);
  });
});

describe("the out check", () => {
  const bad = (out: unknown[]): Policy => ({
    ...fakeDef.policies[0],
    reduce: (s, e) => (e.type === "board.task.filed" ? { state: s, out: out as never } : fakeDef.policies[0].reduce(s, e)),
  });

  test.each([
    ["a generic type", [{ emit: { type: "policy.decider.set", data: { policy: "triage", config: { kind: "agent" } } } }], /generic type/],
    ["an undeclared type", [{ emit: { type: "triage.pushed", data: {} } }], /not in the policy's emits/],
    ["an undeclared command", [{ issue: { type: "git.push", params: {} } }], /not in the policy's commands/],
    ["another policy's card", [{ withdraw: "c_someone_else" }], /not this policy's/],
    ["a reissue", [{ reissue: { command: "k_x" } }], /only the built-in/],
    ["a human command with no packet", [{ issue: { type: "triage.ask-nil", params: {} } }], /needs a packet/],
  ])("refuses %s", (_name, out, why) => {
    const { e } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [bad(out)] })] });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    const refused = e.log.all().filter((x) => x.type === "policy.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].data.reason).toMatch(why);
    expect(e.deciderOf("triage").setAt).toBeNull();
  });

  test("a reducer that throws is refused; the input is still logged", () => {
    const thrower: Policy = { ...fakeDef.policies[0], reduce: () => { throw new Error("boom"); } };
    const { e } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [thrower] })] });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: {} });
    expect(types(e)).toEqual(["policies.loaded", "board.task.filed", "policy.refused"]);
  });

  test("a command to Nil opens an action card that only a human route finishes", () => {
    const ask: Policy = bad([{ issue: { type: "triage.ask-nil", params: {}, packet: { question: "Approve the 2FA prompt on your phone", blocks: [{ type: "checklist", items: ["Open the app", "Approve"] }] } } }]);
    const { e, clock } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [ask] })] });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: {} });
    const card = [...e.cards.values()][0];
    expect(card).toMatchObject({ kind: "action", state: "open", prediction: null });
    expect(() => e.commandResult(card.command!, { ok: true })).toThrow(/never writes as a human/);
    e.completeAction(MEMBER, card.id, { ok: true });
    clock.t += ACTION_UNDO_MS;
    e.finishHeld();
    expect(e.cards.get(card.id)!.state).toBe("done");
    expect(e.log.all().find((x) => x.type === "command.done")).toMatchObject({ by: "human:Nil", member: MEMBER });
  });

  test("X2: the engine holds Done for its Undo time: an Undo sends nothing, a restart keeps it, and it is sent after", () => {
    const ask: Policy = bad([{ issue: { type: "triage.ask-nil", params: {}, packet: { question: "Approve", blocks: [] } } }]);
    const dir = tempDir();
    const clock = { t: Date.parse("2026-10-26T16:00:00Z") };
    const { e } = engine(dir, { clock, projects: [project({ ...fakeDef, policies: [ask] })] });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: {} });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t2", data: {} });
    const [a, b] = [...e.cards.values()];
    e.completeAction(MEMBER, a.id, { ok: true, note: "approved" });
    e.completeAction(MEMBER, b.id, { ok: false, note: "no phone" });
    expect(() => e.completeAction(MEMBER, a.id, { ok: true })).toThrow(/already marked/);
    // One card's Undo leaves the other card's Done held.
    e.undo(MEMBER, b.id);
    expect(e.cards.get(b.id)!.held).toBeUndefined();
    expect(e.cards.get(a.id)!.held).toMatchObject({ ok: true, note: "approved" });
    clock.t += ACTION_UNDO_MS - 1;
    expect(e.finishHeld()).toBe(0);
    // A restart inside the Undo time: the held Done comes back from the log.
    e.close();
    const { e: e2 } = engine(dir, { clock, projects: [project({ ...fakeDef, policies: [ask] })] });
    expect(e2.cards.get(a.id)!.held).toMatchObject({ ok: true });
    clock.t += 1;
    expect(e2.finishHeld()).toBe(1);
    expect(e2.cards.get(a.id)!.state).toBe("done");
    expect(e2.cards.get(a.id)!.held).toBeUndefined();
    expect(e2.commands.get(a.command!)).toMatchObject({ state: "done", result: { note: "approved" } });
    expect(() => e2.undo(MEMBER, a.id)).toThrow(/cannot be undone/);
    expect(e2.cards.get(b.id)!.state).toBe("open");
    expect(e2.commands.get(b.command!)!.state).toBe("issued");
    // The decision log has no line for an action.
    expect(e2.decisions.live()).toHaveLength(0);
    e2.close();
  });
});

describe("Z3, Z11: the option of a call", () => {
  test("decide stores the option the call came from; an option the packet lacks is refused", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    // The fixture packet has no options: any option is refused.
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1", note: "" }, option: "b" })).toThrow(/option must name/);
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1", note: "" } });
    expect(e.cards.get(card.id)!.decision!.option).toBeUndefined();
  });
});

describe("agent routes", () => {
  test("an emitter reports only its declared types; a repeated key is dropped", () => {
    const { e } = engine(tempDir());
    expect(() => e.reportEvent({ project: "isomux", from: "curator", type: "board.task.filed", subject: "t1" })).toThrow(/may not emit/);
    expect(() => e.sourceEvent({ project: "isomux", source: "board", type: "card.decided", subject: "t1" })).toThrow(/generic/);
    expect(() => e.reportEvent({ project: "isomux", from: "nil", type: "board.task.filed" })).toThrow(EngineError);
    const r1 = e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "t9", data: { title: "[go | ready] A", priority: "P1" }, key: "read-1:t9" });
    const r2 = e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "t9", data: { title: "[go | ready] A", priority: "P1" }, key: "read-1:t9" });
    expect([r1.duplicate, r2.duplicate]).toEqual([false, true]);
    // A tagged task gets no card.
    expect(e.cards.size).toBe(0);
  });

  test("a packet needs a raw-source link; an unsolicited packet needs a declared author", () => {
    const { e } = engine(tempDir());
    expect(() => e.postPacket({ policy: "triage", actor: "curator", packet: packet(), meta: { raw: "" } })).toThrow(/meta.raw/);
    expect(() => e.postPacket({ policy: "triage", actor: "nil", packet: packet(), meta: { raw: "x" } })).toThrow(/not an author/);
    expect(() => e.postPacket({ policy: "command-failed", actor: "curator", packet: packet(), meta: { raw: "x" } })).toThrow(/unknown policy/);
    e.postPacket({ policy: "triage", actor: "curator", subject: "t5", packet: packet(), meta: { raw: "board:t5" } });
    expect([...e.cards.values()][0]).toMatchObject({ policy: "triage", subject: "t5", version: 1 });
  });
});

describe("command-failed", () => {
  test("a failed command opens a card; retry reissues it to the same actor under its policy", async () => {
    const { e } = engine(tempDir());
    const card = await fileAndPrepare(e);
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const k = [...e.commands.values()].find((x) => x.type === "triage.apply")!;
    e.commandResult(k.id, { ok: false, error: "board answered 409" });
    await e.settle();
    const fc = [...e.cards.values()].find((c) => c.policy === "command-failed")!;
    expect(fc.packet?.question).toContain("board answered 409");
    e.decide(MEMBER, fc.id, { version: 1, call: { choice: "retry" } });
    const again = [...e.commands.values()].filter((x) => x.type === "triage.apply");
    expect(again).toHaveLength(2);
    expect(again[1]).toMatchObject({ policy: "triage", actor: "curator", state: "issued", params: k.params });
  });
});

describe("review fixes (slice 2, round 2)", () => {
  test.each([
    ["a call outside the schema", { call: { choice: "push-to-prod", priority: "P9" }, confidence: 0.95 }, /must be one of/],
    ["a confidence out of range", { call: { choice: "go", priority: "P1" }, confidence: 7 }, /confidence 7/],
    ["a call that fails the policy's check", { call: { choice: "go" }, confidence: 0.95 }, /needs a priority/],
  ])("an automatic decider with %s decides nothing; the card goes to Nil unpredicted", async (_n, answer, why) => {
    const fake = fakeAgent();
    fake.answer = () => answer;
    const { e } = engine(tempDir(), { fake });
    e.setDecider(MEMBER, "triage", { kind: "threshold", agent: { kind: "agent", model: "fake", criteria: "criteria.md" }, min: 0.9 });
    const c = await fileAndPrepare(e);
    expect(c).toMatchObject({ state: "open", prediction: { by: "code:standin" } });
    expect(e.log.all().find((x) => x.type === "card.predicted")!.data.error).toMatch(why);
    expect([...e.commands.values()].some((k) => k.type === "triage.apply")).toBe(false);
  });

  test("a bad prediction is no Premove under nil either", async () => {
    const fake = fakeAgent();
    fake.answer = () => ({ call: { choice: "ship" }, confidence: 0.5 });
    const { e } = engine(tempDir(), { fake });
    expect((await fileAndPrepare(e)).prediction).toMatchObject({ by: "code:standin" });
  });

  test("refine and rewrite are the engine's: it issues the prepare; the reducer never sees the call", async () => {
    const { e } = engine(tempDir());
    const c = await fileAndPrepare(e);
    const k = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.changed", subject: "t1", data: { title: "Fix it", priority: "P2" } });
    const k2 = [...e.commands.values()].filter((x) => x.type === "triage.prepare" && x.state === "issued").at(-1)!;
    expect(k2.id).not.toBe(k.id);
    const opts = { question: "q", blocks: [], options: [{ id: "a", label: "A", fill: { choice: "go", priority: "P1" } }, { id: "b", label: "B", fill: { choice: "hold", priority: "P2" } }] };
    e.postPacket({ command: k2.id, packet: opts, meta: { raw: "board:t1" } });
    await e.settle();
    e.decide(MEMBER, c.id, { version: 2, call: {}, generic: { kind: "refine", option: "a" } });
    const k3 = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    expect(k3).toMatchObject({ state: "issued", card: c.id, params: { taskId: "t1", revise: "task changed after packet", refine: "a" } });
    expect(types(e)).not.toContain("triage.decided");
    expect([...e.commands.values()].some((x) => x.type === "triage.apply")).toBe(false);
    e.postPacket({ command: k3.id, packet: packet("v3"), meta: { raw: "board:t1" } });
    await e.settle();
    expect(e.cards.get(c.id)).toMatchObject({ state: "open", version: 3 });
  });

  test("a policy with no prepare command takes no rewrite", async () => {
    const def = { ...fakeDef, policies: [{ ...fakeDef.policies[0], prepare: undefined }] };
    const { e } = engine(tempDir(), { projects: [project(def)] });
    const c = await fileAndPrepare(e);
    expect(() => e.decide(MEMBER, c.id, { version: 1, call: { note: "plainer" }, generic: { kind: "rewrite" } })).toThrow(/no prepare command/);
  });

  test("the HTTP fact route cannot write as a source", () => {
    const { e } = engine(tempDir());
    expect(() => e.reportEvent({ project: "isomux", from: "board", type: "board.task.closed", subject: "t1" })).toThrow(/is a source/);
    expect(() => e.sourceEvent({ project: "isomux", source: "curator", type: "board.task.closed", subject: "t1" })).toThrow(EngineError);
  });

  test("a failed write leaves memory as the log says, keeps the replay differences, and the next input works", async () => {
    const dir = tempDir();
    engine(dir).e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    let log: FullDiskLog | undefined;
    class FullDiskLog extends EventLog {
      failNext = false;
      protected writeAll(fd: number, text: string): void {
        if (!this.failNext) return super.writeAll(fd, text);
        this.failNext = false;
        super.writeAll(fd, text.slice(0, 40));
        throw new Error("ENOSPC");
      }
    }
    const quiet: Policy = { ...fakeDef.policies[0], reduce: (s) => ({ state: s }) };
    const { e } = engine(dir, { projects: [project({ ...fakeDef, policies: [quiet] })], makeLog: (d, ids, now) => (log = new FullDiskLog(d, ids, now)) });
    const diffs = e.replayDiffs.length;
    expect(diffs).toBeGreaterThan(0);
    const before = JSON.stringify([...e.cards.values()]);
    log!.failNext = true;
    expect(() => e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t2", data: { title: "B", priority: "P1" } })).toThrow(/ENOSPC/);
    expect(JSON.stringify([...e.cards.values()])).toBe(before);
    expect(e.replayDiffs.length).toBe(diffs);
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t3", data: { title: "C", priority: "P1" } });
    expect(new EventLog(dir, { next: (p) => `${p}_${Math.random()}` }).all().filter((x) => x.type === "board.task.filed").map((x) => x.subject)).toEqual(["t1", "t3"]);
  });
});

describe("review fixes (slice 2, round 3)", () => {
  const codeDef = (step: unknown) => ({
    ...fakeDef,
    handlers: { guess: () => step as never },
    policies: [{ ...fakeDef.policies[0], decider: { kind: "code" as const, handler: "guess" } }],
  });
  const good = { call: { choice: "go", priority: "P1" }, confidence: 0.99, why: "", against: "", by: "code:guess", precedent: [] };

  test.each([
    ["a decided step with no prediction", { kind: "decided", call: { choice: "push-to-prod", priority: "P9" }, confidence: 0.99 }, /needs a prediction/],
    ["a decided step whose call differs from its valid prediction", { kind: "decided", call: { choice: "push-to-prod" }, confidence: 0.99, prediction: good }, null],
  ])("%s never reaches a command with its own call", async (_n, step, why) => {
    const { e } = engine(tempDir(), { projects: [project(codeDef(step))] });
    e.setDecider(MEMBER, "triage", { kind: "code", handler: "guess" });
    const c = await fileAndPrepare(e);
    const applies = [...e.commands.values()].filter((k) => k.type === "triage.apply");
    if (why) {
      expect(c).toMatchObject({ state: "open", prediction: { by: "code:standin" } });
      expect(e.log.all().find((x) => x.type === "card.predicted")!.data.error).toMatch(why);
      expect(applies).toHaveLength(0);
    } else {
      // The engine decides with the checked prediction only.
      expect(c.state).toBe("decided");
      expect(applies.map((k) => (k.params as { call: unknown }).call)).toEqual([{ choice: "go", priority: "P1" }]);
    }
  });

  test("Undo of a rewrite cancels the engine's prepare before delivery", async () => {
    const { e } = engine(tempDir());
    const c = await fileAndPrepare(e);
    e.decide(MEMBER, c.id, { version: 1, call: { note: "plainer" }, generic: { kind: "rewrite" } });
    const k = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    expect(k.state).toBe("issued");
    e.undo(MEMBER, c.id);
    expect(e.commands.get(k.id)!.state).toBe("cancelled");
    expect(e.cards.get(c.id)!.state).toBe("open");
    // Delivered already: the prepare stays (slice 6 looks at that case).
    e.decide(MEMBER, c.id, { version: 1, call: { note: "plainer" }, generic: { kind: "rewrite" } });
    const k2 = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    e.delivered(k2.id);
    e.undo(MEMBER, c.id);
    expect(e.commands.get(k2.id)!.state).toBe("delivered");
  });
});
