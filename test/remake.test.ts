// Remake (Antifeed PM, 2026-10-29): a Premove that an agent made which is not
// its project's Predictor now (Wall Game cards predicted by Isomux Consult
// before each project had its own) gets a new predict from the project's
// Predictor; its answer replaces the Premove, also on a seen card, so the
// chat on the card goes to the agent that made its Premove.
import { afterAll, describe, expect, test } from "bun:test";
import { REMAKE_TRIES } from "../src/engine";
import { folderHash } from "../src/policies";
import isomux from "../projects/isomux/policies";
import { classic, cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";

afterAll(cleanup);

const ISO = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const packet = { question: "Triage: the export has no header row", blocks: [{ type: "markdown" as const, text: "A member adds it by hand." }], options: [{ id: "pick", label: "P2 · go", fill: { choice: "go", priority: "P2" } }], recommended: "pick" };
// The same project with another agent as its Predictor.
const moved = { ...classic(isomux), actors: isomux.actors.map((a) => (a.id === isomux.consult && a.kind === "agent" ? { ...a, agentName: "New Consult" } : a)) };
const asIs = [{ def: classic(isomux), path: ISO, hash: folderHash(ISO) }];
const asMoved = [{ def: moved, path: ISO, hash: folderHash(ISO) }];
const answer = { call: { choice: "go", priority: "P1" }, confidence: 0.8, why: "w", against: "a" };

const predicts = (e: ReturnType<typeof engine>["e"], card: string) => [...e.commands.values()].filter((k) => k.type === "predict" && k.card === card);

// A card with its Premove from Isomux Consult, then the app starts with New Consult as the Predictor.
async function foreign(seen = false) {
  const dir = tempDir();
  const fp = fakePredict();
  const a = engine(dir, { projects: asIs, predict: fp.rt });
  a.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "t1", data: { title: "Export has no header", priority: "P2", status: "open" } });
  const prep = [...a.e.commands.values()].find((k) => k.type === "triage.prepare")!;
  a.e.startCommand(prep.id);
  a.e.postPacket({ command: prep.id, packet, meta: { raw: "https://office.example.com" } });
  await a.e.settle();
  const c = [...a.e.cards.values()].find((x) => x.subject === "t1")!;
  const k = predicts(a.e, c.id)[0];
  a.e.startCommand(k.id);
  a.e.predictionResult(k.id, answer);
  if (seen) a.e.cardShown(MEMBER, c.id, c.version);
  a.e.close();
  const b = engine(dir, { projects: asMoved, predict: fp.rt });
  return { ...b, dir, fp, card: c.id };
}

describe("remake a Premove of another project's Predictor", () => {
  test("one predict to the project's Predictor; its answer replaces the Premove, also on a card Nil saw; no threshold call; replay clean", async () => {
    const s = await foreign(true);
    expect(s.e.cards.get(s.card)!.prediction!.by).toStartWith("agent:Isomux Consult@");
    expect(s.e.remakeForeign()).toBe(1);
    // One at a time per card.
    expect(s.e.remakeForeign()).toBe(0);
    const k = predicts(s.e, s.card).at(-1)!;
    expect(k).toMatchObject({ remake: true, actor: isomux.consult, state: "issued" });
    s.e.startCommand(k.id);
    s.e.predictionResult(k.id, { ...answer, call: { choice: "backlog", priority: null } });
    const c = s.e.cards.get(s.card)!;
    expect(c.prediction!.by).toStartWith("agent:New Consult@");
    expect(c.prediction!.call).toEqual({ choice: "backlog", priority: null });
    expect(c.latePrediction).toBeUndefined();
    expect(c.state).toBe("open");
    // Nil saw the other Predictor's Premove: the remake stays out of calibration.
    expect(c.prediction!.informed).toBe(true);
    // Done: the Premove's maker is the Predictor.
    expect(s.e.remakeForeign()).toBe(0);
    s.e.close();
    const again = engine(s.dir, { projects: asMoved, predict: s.fp.rt });
    expect(again.e.replayDiffs).toEqual([]);
    expect(again.e.cards.get(s.card)!.prediction!.by).toStartWith("agent:New Consult@");
    again.e.close();
  });

  test(`a remake that does not go through is issued again, up to ${REMAKE_TRIES} times per card version`, async () => {
    const s = await foreign();
    for (let i = 0; i < REMAKE_TRIES; i++) {
      expect(s.e.remakeForeign()).toBe(1);
      s.e.dispatchFailed(predicts(s.e, s.card).at(-1)!.id, "not sent");
    }
    expect(s.e.remakeForeign()).toBe(0);
    expect(s.e.cards.get(s.card)!.prediction!.by).toStartWith("agent:Isomux Consult@");
    s.e.close();
  });

  test("a card Nil decides meanwhile keeps his call: the remake closes", async () => {
    const s = await foreign();
    s.e.remakeForeign();
    const c = s.e.cards.get(s.card)!;
    s.e.decide(MEMBER, s.card, { version: c.version, call: { choice: "go", priority: "P2" } });
    expect(predicts(s.e, s.card).at(-1)!.state).toBe("cancelled");
    expect(s.e.remakeForeign()).toBe(0);
    s.e.close();
  });

  test("a remake on a card Nil has not seen counts in calibration; on a card with a chat of his it is informed", async () => {
    const s = await foreign();
    s.e.remakeForeign();
    let k = predicts(s.e, s.card).at(-1)!;
    s.e.startCommand(k.id);
    s.e.predictionResult(k.id, answer);
    expect(s.e.cards.get(s.card)!.prediction!.informed).toBeUndefined();
    s.e.close();
    const t = await foreign();
    t.e.chatSend(MEMBER, t.card, "Why go?");
    t.e.remakeForeign();
    k = predicts(t.e, t.card).at(-1)!;
    t.e.startCommand(k.id);
    t.e.predictionResult(k.id, answer);
    expect(t.e.cards.get(t.card)!.prediction!.informed).toBe(true);
    t.e.close();
  });

  test("a stand-in Premove is never remade", async () => {
    const s = await foreign();
    const c = s.e.cards.get(s.card)!;
    c.prediction = { ...c.prediction!, by: "agent:standin@sonnet#s1", standin: { reason: "busy" } } as typeof c.prediction;
    expect(s.e.remakeForeign()).toBe(0);
    s.e.close();
  });

  test("no remake when the Premove's maker is the project's Predictor", async () => {
    const s = await foreign();
    s.e.close();
    const same = engine(s.dir, { projects: asIs, predict: s.fp.rt });
    expect(same.e.remakeForeign()).toBe(0);
    same.e.close();
  });
});
