import { afterAll, describe, expect, test } from "bun:test";
import demo from "../projects/demo/policies";
import { seed } from "../projects/demo/seed";
import { folderHash } from "../src/policies";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";

afterAll(cleanup);

const PATH = new URL("../projects/demo/policies.ts", import.meta.url).pathname;

describe("demo policies", () => {
  test("round 9: an Undo cancels the demo.apply of the call (the dispatcher holds it for the Undo time)", async () => {
    const { e } = engine(tempDir(), { projects: [{ def: demo, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
    const it = seed.find((x) => x.id === "demo-2")!;
    e.sourceEvent({ project: "demo", source: "seed", type: "demo.item", subject: it.id, data: it, key: it.id });
    await e.settle();
    const c = [...e.cards.values()].find((x) => x.subject === "demo-2")!;
    const k = [...e.commands.values()].find((x) => x.type === "predict" && x.card === c.id && x.state === "issued");
    if (k) {
      e.startCommand(k.id);
      e.predictionResult(k.id, { call: { choice: "backlog", priority: null }, confidence: 0.6, why: "w", against: "a" });
    }
    e.decide(MEMBER, c.id, { version: c.version, call: { choice: "backlog", priority: null } });
    const apply = [...e.commands.values()].find((x) => x.type === "demo.apply" && x.card === c.id)!;
    expect(apply.state).toBe("issued");
    e.undo(MEMBER, c.id);
    expect(e.commands.get(apply.id)!.state).toBe("cancelled");
    expect(e.log.all().some((x) => x.type === "policy.refused")).toBe(false);
  });
});

describe("round 9: an image's focus", () => {
  test("checkPacket takes a focus inside the image and refuses one outside it", async () => {
    const { checkPacket } = await import("../src/validate");
    const blob = "a".repeat(64) + ".png";
    const img = (focus: unknown) => ({ question: "q", blocks: [{ type: "image", blob, focus }] });
    expect(checkPacket(img({ x: 0.03, y: 0.79, w: 0.94, h: 0.2 }) as never)).toBeNull();
    expect(checkPacket(img({ x: 0.5, y: 0.5, w: 0.6, h: 0.1 }) as never)).toMatch(/focus must be/);
    expect(checkPacket(img({ x: 0.1, y: 0.1, w: 0, h: 0.1 }) as never)).toMatch(/focus must be/);
    expect(checkPacket(img("top") as never)).toMatch(/focus must be/);
  });
});
