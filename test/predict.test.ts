// The consult agent's predict command and the stand-ins (DESIGN.md 13.1).
import { afterAll, describe, expect, test } from "bun:test";
import { makeApi, MEMBER_HEADER } from "../src/api";
import { Blobs } from "../src/blobs";
import { calibration } from "../src/metrics";
import { checkProject, folderHash } from "../src/policies";
import isomux from "../projects/isomux/policies";
import { triage } from "../projects/isomux/triage";
import type { PredictRuntime } from "../src/engine";
import type { ProjectDef } from "../src/policies";
import { classic, cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { Dispatcher } from "../src/dispatcher";
import { PREDICT_IN_FLIGHT, STANDIN_AT_ONCE } from "../src/engine";
import { FakeOffice } from "./fake-office";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { consultInputFactory } from "../src/predictor";

afterAll(cleanup);

const PATH = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const load = (def: ProjectDef = classic(isomux)) => [{ def, path: PATH, hash: folderHash(PATH) }];
const packet = { question: "Triage: the export has no header row", blocks: [{ type: "markdown" as const, text: "A member adds it by hand." }], options: [{ id: "a", label: "Go P1", fill: { choice: "go", priority: "P1" } }, { id: "b", label: "Backlog", fill: { choice: "backlog", priority: null } }], recommended: "b" };
const ANSWER = { call: { choice: "go", priority: "P1" }, confidence: 0.8, why: "A visible bug.", against: "Few members export." };

function setup(over: Partial<PredictRuntime> = {}, def?: ProjectDef) {
  const fp = fakePredict(over);
  const x = engine(tempDir(), { projects: load(def), predict: fp.rt });
  return { ...x, blobs: fp.blobs };
}
type E = ReturnType<typeof setup>["e"];
// A card at "predicting", with its packet in, and its predict delivered
// (the dispatcher's part): the start timer runs from the delivery.
async function card(e: E, id = "t1", pk: typeof packet | { question: string; blocks: typeof packet.blocks } = packet) {
  e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: id, data: { title: "Export has no header", priority: "P2", status: "open" } });
  const prep = [...e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === id)!;
  e.startCommand(prep.id);
  e.postPacket({ command: prep.id, packet: pk, meta: { raw: "https://office.example.com" } });
  await e.settle();
  const c = [...e.cards.values()].find((c) => c.subject === id)!;
  const k = [...e.commands.values()].filter((k) => k.type === "predict" && k.card === c.id).at(-1);
  if (k && k.state === "issued") e.delivered(k.id);
  return c;
}
const predictOf = (e: E, cardId: string) => [...e.commands.values()].filter((k) => k.type === "predict" && k.card === cardId).at(-1)!;

describe("predict", () => {
  test("a packet issues a predict with the exact input; the agent's answer is the Premove, with both blobs", async () => {
    const { e, blobs } = setup();
    const c = await card(e);
    expect(c.state).toBe("predicting");
    const k = predictOf(e, c.id);
    expect(k).toMatchObject({ actor: "consult", state: "delivered", params: { card: c.id, version: 1, criteriaHash: "crit0001" } });
    expect(blobs.get((k.params as { input: string }).input)).toContain("triage-criteria.md");
    e.startCommand(k.id);
    e.predictionResult(k.id, ANSWER);
    const now = e.cards.get(c.id)!;
    expect(now.state).toBe("open");
    expect(now.prediction).toMatchObject({ ...ANSWER, by: "agent:Isomux Consult@claude-opus-5-5#crit0001", input: (k.params as { input: string }).input });
    expect(JSON.parse(blobs.get(now.prediction!.answer!)!)).toEqual(ANSWER);
    expect(e.commands.get(k.id)!.state).toBe("done");
    // Not the card's own command: no "changed after packet" mark.
    expect(now.changedAfterPacket).toBeUndefined();
  });

  test("a prediction is taken only for a started predict of the card's current version", async () => {
    const { e } = setup();
    const c = await card(e);
    const k = predictOf(e, c.id);
    expect(() => e.predictionResult(k.id, ANSWER)).toThrow(/start the command first/);
    expect(() => e.predictionResult("k_nope", ANSWER)).toThrow(/unknown command/);
    const prep = [...e.commands.values()].find((x) => x.type === "triage.prepare")!;
    expect(() => e.predictionResult(prep.id, ANSWER)).toThrow(/asks for no prediction/);
    e.startCommand(k.id);
    expect(() => e.predictionResult(k.id, { ...ANSWER, call: { choice: "ship-it" } })).toThrow(/prediction refused/);
    expect(() => e.predictionResult(k.id, { ...ANSWER, confidence: 3 })).toThrow(/prediction refused/);
    expect(e.cards.get(c.id)!.state).toBe("predicting");
  });

  test("a project with no consult agent: no predict goes out, and the stand-in makes the Premove at the next check", async () => {
    const { e } = setup({}, { ...isomux, consult: undefined });
    const c = await card(e);
    expect([...e.commands.values()].filter((k) => k.type === "predict")).toEqual([]);
    expect(e.checkPredicts()).toBe(1);
    await e.settle();
    expect(e.cards.get(c.id)!).toMatchObject({ state: "open", prediction: { by: "agent:standin@sonnet#s1", standin: { reason: "this project has no consult agent" } } });
  });

  test("busy: no start in startMs cancels the predict and the claude -p stand-in fills in", async () => {
    const { e, clock } = setup();
    const c = await card(e);
    const k = predictOf(e, c.id);
    clock.t += 119_000;
    expect(e.checkPredicts()).toBe(0);
    clock.t += 2_000;
    expect(e.checkPredicts()).toBe(1);
    await e.settle();
    expect(e.commands.get(k.id)!.state).toBe("cancelled");
    expect(e.cards.get(c.id)!).toMatchObject({ state: "open", prediction: { by: "agent:standin@sonnet#s1", standin: { reason: "Isomux Consult was busy: it did not start within 120 s" } } });
    // Its start now gets 409: the agent does not act on it.
    expect(() => e.startCommand(k.id)).toThrow(/cancelled/);
    // No failure card for a predict.
    expect([...e.cards.values()].filter((x) => x.policy === "command-failed")).toHaveLength(0);
  });

  test("the claude -p stand-in fails too: the code vote fills in, with both reasons", async () => {
    const { e, clock } = setup({ standin: async () => { throw new Error("claude is down"); } });
    const c = await card(e);
    clock.t += 121_000;
    e.checkPredicts();
    await e.settle();
    expect(e.cards.get(c.id)!.prediction).toMatchObject({ by: "code:standin", call: { choice: "backlog", priority: null }, why: "The author's pick: there are no past calls to vote with yet.", standin: { predictorError: "the quick model run failed: claude is down", basis: "author" } });
    // Z3, Z11: the call keeps the option it came from.
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "backlog", priority: null, note: "" }, option: "b" });
    expect(e.cards.get(c.id)!.decision!.option).toBe("b");
    expect(() => e.undo(MEMBER, c.id)).not.toThrow();
    expect(() => e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1", note: "" }, option: "z" })).toThrow(/option must name/);
  });

  test("late: started, no answer in answerMs; the answer after the stand-in replaces it only if Nil has not seen the card", async () => {
    const { e, clock } = setup();
    const a = await card(e, "t1");
    const b = await card(e, "t2");
    for (const c of [a, b]) e.startCommand(predictOf(e, c.id).id);
    clock.t += 601_000;
    expect(e.checkPredicts()).toBe(2);
    await e.settle();
    expect(predictOf(e, a.id).state).toBe("started");
    // Nil saw b's stand-in; a is unseen.
    e.cardShown(MEMBER, b.id, 1);
    e.predictionResult(predictOf(e, a.id).id, ANSWER);
    e.predictionResult(predictOf(e, b.id).id, ANSWER);
    expect(e.cards.get(a.id)!.prediction).toMatchObject({ by: "agent:Isomux Consult@claude-opus-5-5#crit0001" });
    expect(e.cards.get(b.id)!.prediction).toMatchObject({ by: "agent:standin@sonnet#s1" });
    expect(e.cards.get(b.id)!.latePrediction).toMatchObject({ call: ANSWER.call });
    expect(e.log.all().filter((x) => x.type === "card.predicted" && x.data.late).map((x) => !!x.data.seen)).toEqual([false, true]);
  });

  test("E1: a late answer Nil did not see as the Premove stays out of the decision line and the agent's calibration", async () => {
    const { e, clock } = setup();
    const c = await card(e);
    const k = predictOf(e, c.id);
    e.startCommand(k.id);
    clock.t += 601_000;
    e.checkPredicts();
    await e.settle();
    e.cardShown(MEMBER, c.id, 1);
    e.predictionResult(k.id, ANSWER);
    // Nil keeps the stand-in's call: a match for the stand-in, nothing for the agent.
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "backlog", priority: null } });
    const line = e.decisions.live().at(-1)!;
    expect(line.prediction!.by).toBe("agent:standin@sonnet#s1");
    expect(line.outcome).toBe("matched");
    expect(calibration(e.decisions.live(), "triage").map((x) => x.predictor)).toEqual(["agent:standin@sonnet#s1"]);
  });

  test("the last stand-in tier is the policy's fallback, never the first values", async () => {
    const { e, clock } = setup({ standin: async () => { throw new Error("down"); } });
    // No options and no author's pick, no past calls: no basis.
    const c = await card(e, "t1", { question: packet.question, blocks: packet.blocks });
    clock.t += 121_000;
    e.checkPredicts();
    await e.settle();
    const p = e.cards.get(c.id)!.prediction!;
    expect(p).toMatchObject({ call: { choice: "backlog", priority: null }, confidence: 0, why: "No basis: you have made no calls on this kind of card yet, and the author named no pick.", standin: { basis: "none" } });
  });

  test("the card moves on: an issued predict is cancelled, a started one fails with 'card moved on', and a late answer gets 409", async () => {
    const { e } = setup();
    const a = await card(e, "t1");
    const b = await card(e, "t2");
    const ka = predictOf(e, a.id);
    const kb = predictOf(e, b.id);
    e.startCommand(kb.id);
    // A board change withdraws a and b (tagged).
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.changed", subject: "t1", data: { title: "[go | ready] x", priority: "P2", status: "open" } });
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.changed", subject: "t2", data: { title: "[go | ready] y", priority: "P2", status: "open" } });
    expect(e.commands.get(ka.id)!.state).toBe("cancelled");
    // Superseded (Antifeed PM, 2026-10-30): the log keeps "card moved on"; it is no failure to fix.
    expect(e.commands.get(kb.id)!).toMatchObject({ state: "failed", error: "card moved on", superseded: true });
    expect(e.failures().map((k) => k.id)).not.toContain(kb.id);
    expect(() => e.predictionResult(kb.id, ANSWER)).toThrow(/failed/);
    expect([...e.cards.values()].filter((x) => x.policy === "command-failed")).toHaveLength(0);
  });

  test("a new packet version closes the old predict and issues one for the new version", async () => {
    const { e } = setup();
    const c = await card(e);
    const k1 = predictOf(e, c.id);
    e.startCommand(k1.id);
    e.predictionResult(k1.id, ANSWER);
    e.decide(MEMBER, c.id, { version: 1, call: { note: "plainer" }, generic: { kind: "rewrite" } });
    const prep = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    e.startCommand(prep.id);
    e.postPacket({ command: prep.id, packet, meta: { raw: "x" } });
    const k2 = predictOf(e, c.id);
    expect(k2.id).not.toBe(k1.id);
    expect(k2.params).toMatchObject({ version: 2 });
  });

  test("informed: the agent says so, or version 2 after Nil saw version 1; its own calibration row", async () => {
    const { e } = setup();
    const a = await card(e, "t1");
    const ka = predictOf(e, a.id);
    e.startCommand(ka.id);
    e.predictionResult(ka.id, { ...ANSWER, informed: true });
    expect(e.cards.get(a.id)!.prediction!.informed).toBe(true);
    const b = await card(e, "t2");
    const kb = predictOf(e, b.id);
    e.startCommand(kb.id);
    e.predictionResult(kb.id, ANSWER);
    expect(e.cards.get(b.id)!.prediction!.informed).toBeUndefined();
    e.cardShown(MEMBER, b.id, 1);
    e.decide(MEMBER, b.id, { version: 1, call: { note: "plainer" }, generic: { kind: "rewrite" } });
    const prep = [...e.commands.values()].filter((x) => x.type === "triage.prepare").at(-1)!;
    e.startCommand(prep.id);
    e.postPacket({ command: prep.id, packet, meta: { raw: "x" } });
    const kb2 = predictOf(e, b.id);
    e.startCommand(kb2.id);
    e.predictionResult(kb2.id, ANSWER);
    expect(e.cards.get(b.id)!.prediction!.informed).toBe(true);
    e.decide(MEMBER, a.id, { version: 1, call: ANSWER.call });
    const rows = calibration(e.decisions.live(), "triage");
    const informed = rows.find((x) => x.predictor === "agent:Isomux Consult@claude-opus-5-5#crit0001 (informed)")!;
    expect(informed.bands.reduce((n, x) => n + x.n, 0)).toBe(1);
  });

  test("threshold decides only with the agent's own on-time, not informed call; a stand-in never decides", async () => {
    const def = { ...isomux, policies: [{ ...triage, autoAllowed: true, decider: { kind: "threshold" as const, agent: { kind: "consult" as const, criteria: "triage-criteria.md" }, min: 0.7 } }] };
    const { e, clock } = setup({ standin: async () => ({ ...ANSWER, confidence: 0.99, by: "agent:standin@sonnet#s1" }) }, def);
    e.setDecider(MEMBER, "triage", def.policies[0].decider);
    const a = await card(e, "t1");
    const ka = predictOf(e, a.id);
    e.startCommand(ka.id);
    e.predictionResult(ka.id, { ...ANSWER, informed: true });
    expect(e.cards.get(a.id)!.state).toBe("open");
    const b = await card(e, "t2");
    clock.t += 121_000;
    e.checkPredicts();
    await e.settle();
    expect(e.cards.get(b.id)!.state).toBe("open");
    const c = await card(e, "t3");
    const kc = predictOf(e, c.id);
    e.startCommand(kc.id);
    e.predictionResult(kc.id, ANSWER);
    expect(e.cards.get(c.id)!.state).toBe("decided");
  });

  test("card.shown: once per version, Nil's only", async () => {
    const { e } = setup();
    const c = await card(e);
    expect(e.cardShown(MEMBER, c.id, 1)).toHaveLength(1);
    expect(e.cardShown(MEMBER, c.id, 1)).toHaveLength(0);
    expect(() => e.cardShown("", c.id, 1)).toThrow(/member id/);
  });
});

describe("the policies check", () => {
  test("a decision policy needs a predictor; the consult agent is never an author or a command's actor", () => {
    expect(checkProject(isomux)).toEqual([]);
    const noPredictor = { ...isomux, policies: [{ ...triage, decider: { kind: "nil" as const } }] };
    expect(checkProject(noPredictor)).toContain('policy "triage": a nil decider needs a predictor');
    const asAuthor = { ...isomux, policies: [{ ...triage, author: "consult" }] };
    expect(checkProject(asAuthor)).toContain('policy "triage": the consult agent "consult" cannot be an author');
    const asActor = { ...isomux, policies: [{ ...triage, commands: { ...triage.commands, "triage.apply": { ...triage.commands["triage.apply"], actor: "consult" } } }] };
    expect(checkProject(asActor)).toContain('policy "triage": command "triage.apply" goes to the consult agent, which only predicts');
    // A project with no consult agent is allowed (the Inbox, 2026-10-28): the stand-in makes each Premove.
    expect(checkProject({ ...isomux, consult: undefined })).toEqual([]);
    expect(checkProject({ ...isomux, policies: [{ ...triage, fallback: undefined }] })).toContain('policy "triage": a policy with a decider needs a fallback call');
    expect(checkProject({ ...isomux, policies: [{ ...triage, fallback: { choice: "go", priority: null } }] })).toContain('policy "triage": fallback: go needs a priority');
  });
});

describe("routes", () => {
  test("the prediction route, the context route, card.shown is Nil's, and the old consult route is gone", async () => {
    const dir = tempDir();
    const fp = fakePredict();
    const { e } = engine(dir, { projects: load(), predict: fp.rt });
    const c = await card(e);
    const blobs = new Blobs(dir);
    const api = makeApi({ engine: e, blobs, member: MEMBER, base: "http://x", context: (id) => ({ id }) });
    const call = (m: string, path: string, body?: unknown, member = false) =>
      api(new Request(`http://x${path}`, { method: m, headers: { "Content-Type": "application/json", ...(member ? { [MEMBER_HEADER]: MEMBER } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const k = predictOf(e, c.id);
    expect((await call("POST", `/api/commands/${k.id}/prediction`, ANSWER)).status).toBe(409);
    await call("POST", `/api/commands/${k.id}/start`);
    expect((await call("POST", `/api/commands/${k.id}/prediction`, ANSWER)).status).toBe(200);
    expect((await call("POST", `/api/cards/${c.id}/shown`, { version: 1 })).status).toBe(403);
    expect((await call("POST", `/api/cards/${c.id}/shown`, { version: 1 }, true)).status).toBe(200);
    expect((await call("POST", `/api/cards/${c.id}/consult`, { text: "why?" }, true)).status).toBe(410);
    expect(await (await call("GET", "/api/consult/context")).json()).toMatchObject({ focus: null });
    expect((await call("POST", "/api/consult/focus", { card: c.id })).status).toBe(403);
    await call("POST", "/api/consult/focus", { card: c.id }, true);
    expect(await (await call("GET", "/api/consult/context")).json()).toEqual({ focus: c.id, id: c.id });
  });
});

// Go-live burst (Antifeed PM, 2026-10-26): 32 predicts at once reached the
// consult as one turn and none started in time; 31 stand-ins at once ran out
// of memory. Now the predicts queue, the stand-ins queue, and a card left
// with no basis gets one more predict.
describe("predict bursts", () => {
  // Cards whose predicts are left issued: the dispatcher hands them over.
  async function burst(n: number, over: Partial<PredictRuntime> = {}, pk: typeof packet | { question: string; blocks: typeof packet.blocks } = packet) {
    const x = setup(over);
    const office = new FakeOffice();
    office.roster = [{ id: "agent-consult", name: "Isomux Consult" }];
    const d = new Dispatcher(x.e, office, "http://127.0.0.1:1", () => x.clock.t);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = "b" + i;
      x.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: id, data: { title: "Task " + i, priority: "P2", status: "open" } });
      const prep = [...x.e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === id)!;
      x.e.startCommand(prep.id);
      x.e.postPacket({ command: prep.id, packet: pk, meta: { raw: "https://office.example.com" } });
      await x.e.settle();
      ids.push([...x.e.cards.values()].find((c) => c.subject === id)!.id);
    }
    const predicts = () => [...x.e.commands.values()].filter((k) => k.type === "predict");
    return { ...x, office, d, ids, predicts };
  }

  test("the dispatcher hands the consult at most PREDICT_IN_FLIGHT predicts; the next goes when one is answered", async () => {
    const s = await burst(5);
    s.clock.t += 1_000;
    await s.d.tick();
    expect(s.office.sent).toHaveLength(1);
    expect(s.predicts().map((k) => k.state)).toEqual([...Array(PREDICT_IN_FLIGHT).fill("delivered"), ...Array(5 - PREDICT_IN_FLIGHT).fill("issued")]);
    const [k0] = s.predicts();
    s.e.startCommand(k0.id);
    await s.d.tick();
    expect(s.office.sent).toHaveLength(1);
    s.e.predictionResult(k0.id, ANSWER);
    await s.d.tick();
    expect(s.office.sent).toHaveLength(2);
    expect(s.predicts().filter((k) => k.state === "issued")).toHaveLength(5 - PREDICT_IN_FLIGHT - 1);
  });

  test("the start timer runs from the delivery: a predict that waited in the queue is not late; one that waited answerMs gets the stand-in", async () => {
    const s = await burst(4);
    await s.d.tick();
    const ks = s.predicts();
    // The first three time out from their delivery; the fourth waits in the queue, then goes.
    s.clock.t += 121_000;
    expect(s.e.checkPredicts()).toBe(STANDIN_AT_ONCE);
    await s.e.settle();
    expect(s.e.checkPredicts()).toBe(PREDICT_IN_FLIGHT - STANDIN_AT_ONCE);
    await s.e.settle();
    await s.d.tick();
    expect(s.e.commands.get(ks[3].id)!.state).toBe("delivered");
    s.clock.t += 119_000;
    expect(s.e.checkPredicts()).toBe(0);
    s.clock.t += 2_000;
    expect(s.e.checkPredicts()).toBe(1);
    await s.e.settle();
    // Queued for answerMs with no place free: the stand-in runs, with its own reason.
    const q = await burst(PREDICT_IN_FLIGHT + 1);
    await q.d.tick();
    for (const k of q.predicts().slice(0, PREDICT_IN_FLIGHT)) q.e.startCommand(k.id);
    q.clock.t += 600_000;
    for (let i = 0; i < 3; i++) {
      q.e.checkPredicts();
      await q.e.settle();
    }
    expect(q.e.cards.get(q.ids[PREDICT_IN_FLIGHT])!.prediction).toMatchObject({ standin: { reason: "Isomux Consult had other cards to predict first: this one waited 10 min" } });
  });

  test("at most STANDIN_AT_ONCE claude -p stand-ins run at a time; the others wait for the next check", async () => {
    let running = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const s = await burst(5, {
      standin: async () => {
        most = Math.max(most, ++running);
        await new Promise<void>((r) => gates.push(r));
        running--;
        return { call: { choice: "backlog", priority: null }, confidence: 0.5, why: "stand-in", against: "x", by: "agent:standin@sonnet#s1" };
      },
    });
    for (const k of s.predicts()) s.e.delivered(k.id);
    s.clock.t += 121_000;
    expect(s.e.checkPredicts()).toBe(STANDIN_AT_ONCE);
    expect(s.e.checkPredicts()).toBe(0);
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(1);
      gates.shift()?.();
      await Bun.sleep(1);
      s.e.checkPredicts();
    }
    while (gates.length) gates.shift()!();
    await s.e.settle();
    expect(most).toBe(STANDIN_AT_ONCE);
    expect(s.ids.map((id) => s.e.cards.get(id)!.state)).toEqual(Array(5).fill("open"));
  });

  test("predict again: a card left with no basis that Nil has not seen gets one more predict, and its answer is the Premove", async () => {
    const down = { standin: async () => { throw new Error("claude is down"); } };
    const bare = { question: packet.question, blocks: packet.blocks };
    const s = await burst(3, down, bare);
    for (const k of s.predicts()) s.e.delivered(k.id);
    s.clock.t += 121_000;
    // Two stand-ins (STANDIN_AT_ONCE); Nil sees card 1 before the next check.
    expect(s.e.checkPredicts()).toBe(2);
    await s.e.settle();
    s.e.cardShown(MEMBER, s.ids[1], 1);
    // Card 0 gets its predict again, card 2 its stand-in; Nil then decides card 2.
    expect(s.e.checkPredicts()).toBe(2);
    await s.e.settle();
    expect(s.ids.map((id) => s.e.cards.get(id)!.prediction!.standin!.basis)).toEqual(["none", "none", "none"]);
    s.e.decide(MEMBER, s.ids[2], { version: 1, call: { choice: "go", priority: "P1" } });
    s.clock.t += 5_000;
    expect(s.e.checkPredicts()).toBe(0);
    const again = s.predicts().filter((k) => k.state === "issued");
    expect(again.map((k) => k.card)).toEqual([s.ids[0]]);
    await s.d.tick();
    s.e.startCommand(again[0].id);
    s.e.predictionResult(again[0].id, ANSWER);
    expect(s.e.cards.get(s.ids[0])!.prediction).toMatchObject({ ...ANSWER, by: "agent:Isomux Consult@claude-opus-5-5#crit0001" });
    expect(s.e.cards.get(s.ids[2])!.decision).toMatchObject({ call: { choice: "go", priority: "P1" } });
    // A card that waits for its Premove goes before a predict again, whatever came first.
    const w = await burst(PREDICT_IN_FLIGHT + 1, down, bare);
    for (const k of w.predicts()) w.e.delivered(k.id);
    w.clock.t += 121_000;
    for (let i = 0; i < 3; i++) {
      w.e.checkPredicts();
      await w.e.settle();
    }
    w.e.checkPredicts();
    const agains = w.predicts().filter((k) => k.state === "issued");
    expect(agains).toHaveLength(PREDICT_IN_FLIGHT + 1);
    w.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "late", data: { title: "Late", priority: "P2", status: "open" } });
    const prep = [...w.e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === "late")!;
    w.e.startCommand(prep.id);
    w.e.postPacket({ command: prep.id, packet: bare, meta: { raw: "https://office.example.com" } });
    await w.e.settle();
    await w.d.tick();
    const lateCard = [...w.e.cards.values()].find((c) => c.subject === "late")!;
    const sent = w.predicts().filter((k) => k.state === "delivered");
    expect(sent).toHaveLength(PREDICT_IN_FLIGHT);
    expect(sent.some((k) => k.card === lateCard.id)).toBe(true);
    // Only once: a card whose second predict is not answered keeps its stand-in.
    const t = await burst(1, down, bare);
    t.e.delivered(t.predicts()[0].id);
    t.clock.t += 121_000;
    t.e.checkPredicts();
    await t.e.settle();
    t.e.checkPredicts();
    await t.d.tick();
    t.clock.t += 121_000;
    t.e.checkPredicts();
    t.clock.t += 121_000;
    t.e.checkPredicts();
    await t.d.tick();
    expect(t.predicts().map((k) => k.state)).toEqual(["cancelled", "cancelled"]);
    expect(t.e.cards.get(t.ids[0])!.prediction).toMatchObject({ by: "code:standin", standin: { basis: "none" } });
  });
});

// Nil, 2026-10-29: "tell the agent where to find past calls" instead of feeding them each time.
describe("past calls by route", () => {
  test("the consult's input names the route and the count; the stand-in's prompt keeps the lines", async () => {
    const texts: string[] = [];
    const { e, clock, blobs } = setup({
      input: () => ({ text: "consult input", standinText: "stand-in input with lines", criteriaHash: "crit0001", precedent: ["d_1"], pastCalls: 3 }),
      standin: async (_p, text) => (texts.push(text), { call: { choice: "backlog", priority: null }, confidence: 0.5, why: "stand-in", against: "x", by: "agent:standin@sonnet#s1" }),
    });
    const c = await card(e);
    const k = predictOf(e, c.id);
    expect(k.params).toMatchObject({ precedent: [], pastCalls: 3 });
    expect(blobs.get((k.params as { input: string }).input)).toBe("consult input");
    // No start in time: the stand-in gets its own prompt, with the lines, and names them.
    clock.t += 121_000;
    e.checkPredicts();
    await e.settle();
    expect(texts).toEqual(["stand-in input with lines"]);
    expect(e.cards.get(c.id)!.prediction).toMatchObject({ precedent: ["d_1"] });
    // The consult's own Premove carries the count, and no precedent ids.
    const c2 = await card(e, "t2");
    const k2 = predictOf(e, c2.id);
    e.startCommand(k2.id);
    e.predictionResult(k2.id, ANSWER);
    expect(e.cards.get(c2.id)!.prediction).toMatchObject({ precedent: [], pastCalls: 3 });
  });

  test("GET /api/policies/:id/past-calls: newest first with ids and times, ?after for the newer ones; the input says the count and the route", async () => {
    const dir = tempDir();
    const fp = fakePredict();
    const { e, clock } = engine(dir, { projects: load(), predict: fp.rt });
    const api = makeApi({ engine: e, blobs: new Blobs(dir), member: MEMBER, base: "http://x" });
    const get = async (path: string) => {
      const r = await api(new Request(`http://x${path}`));
      return { status: r.status, body: (await r.json()) as any };
    };
    for (const id of ["t1", "t2"]) {
      const c = await card(e, id);
      const k = predictOf(e, c.id);
      e.startCommand(k.id);
      e.predictionResult(k.id, ANSWER);
      e.decide(MEMBER, c.id, { version: c.version, call: { choice: "go", priority: "P1", note: "" } });
      clock.t += 60_000;
    }
    const all = await get("/api/policies/triage/past-calls");
    expect(all.status).toBe(200);
    expect(all.body.n).toBe(2);
    expect(all.body.calls.map((x: any) => x.at)).toEqual([...all.body.calls.map((x: any) => x.at)].sort().reverse());
    expect(all.body.newestAt).toBe(all.body.calls[0].at);
    expect(all.body.calls[0]).toMatchObject({ id: expect.any(String), text: expect.stringContaining("Nil's call: choice=go, priority=P1") });
    expect((await get(`/api/policies/triage/past-calls?after=${encodeURIComponent(all.body.calls[1].at)}`)).body.calls.map((x: any) => x.id)).toEqual([all.body.calls[0].id]);
    expect((await get(`/api/policies/triage/past-calls?after=${encodeURIComponent(all.body.newestAt)}`)).body.calls).toEqual([]);
    expect((await get("/api/policies/nope/past-calls")).status).toBe(404);
    expect((await get("/api/policies/triage/past-calls?after=soon")).status).toBe(400);
    // The real input: the count and the route, no lines; the stand-in's prompt has the lines.
    writeFileSync(join(dir, "criteria.md"), "How Nil triages.");
    const input = consultInputFactory({ folderOf: () => dir, answerOf: () => isomux.policies[0].answer!, base: "http://127.0.0.1:1" })("triage", "criteria.md", [...e.cards.values()][0], e.decisions.precedent("triage"));
    expect(input.pastCalls).toBe(2);
    expect(input.text).toContain(`His past calls on this kind: 2, the newest at ${all.body.newestAt}.`);
    expect(input.text).toContain("GET http://127.0.0.1:1/api/policies/triage/past-calls");
    expect(input.text).not.toContain("Nil's call:");
    expect(input.standinText).toContain("Nil's call: choice=go, priority=P1");
    expect(input.precedent).toHaveLength(2);
  });
});
