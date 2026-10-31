import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outcome } from "../src/decisions";
import { checkCall, snapToOptions } from "../src/validate";
import type { Prediction } from "../src/types";
import { engine, fileAndPrepare, MEMBER, tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const answer = { choice: { enum: ["go", "backlog"] }, priority: { enum: ["P1", "P2", null] } };
const pred = (call: Prediction["call"]): Prediction => ({ call, confidence: 0.9, why: "", against: "", by: "agent:p", precedent: [] });

describe("outcome", () => {
  const draftPacket = { question: "q", blocks: [{ type: "draft" as const, key: "reply", text: "Thanks!" }] };
  test.each([
    ["the same call", pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1" }, undefined, "matched"],
    ["a priority bump", pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P2" }, undefined, "edited"],
    ["the same call with a note", pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1", note: "also iOS" }, undefined, "edited"],
    ["another choice", pred({ choice: "go", priority: "P1" }), { choice: "backlog", priority: null }, undefined, "changed"],
    ["a rewrite", pred({ choice: "go", priority: "P1" }), { note: "plainer" }, { kind: "rewrite" as const }, "changed"],
    ["no prediction", null, { choice: "go", priority: "P1" }, undefined, "unpredicted"],
  ])("%s", (_n, p, call, generic, want) => {
    expect(outcome(p, call, generic, answer, ["choice"], null)).toBe(want as never);
  });
  test("a note an option filled in is not an edit; a note Nil typed is", () => {
    const packet = { question: "q", blocks: [], options: [{ id: "b", label: "B", fill: { choice: "go", priority: "P1", note: "B: withdraw at the next read" } }] };
    expect(outcome(pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1", note: "B: withdraw at the next read" }, undefined, answer, ["choice"], packet)).toBe("matched");
    expect(outcome(pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1", note: "B, and tell the worker" }, undefined, answer, ["choice"], packet)).toBe("edited");
  });

  test("needs and noneWith rules", () => {
    const rules = { choice: { enum: ["go", "backlog"] }, priority: { enum: ["P1", null], label: "Priority", needs: { choice: ["go"] }, noneWith: { choice: ["backlog"] } } };
    expect(checkCall(rules, { choice: "go", priority: null }, undefined, null)).toBe("go needs a priority");
    expect(checkCall(rules, { choice: "backlog", priority: "P1" }, undefined, null)).toBe("backlog takes no priority");
    expect(checkCall(rules, { choice: "go", priority: "P1" }, undefined, null)).toBeNull();
  });

  test("an edited draft is an edit", () => {
    expect(outcome(pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1", reply: "Thanks a lot!" }, undefined, answer, ["choice"], draftPacket)).toBe("edited");
    expect(outcome(pred({ choice: "go", priority: "P1" }), { choice: "go", priority: "P1", reply: "Thanks!" }, undefined, answer, ["choice"], draftPacket)).toBe("matched");
  });
});

describe("snapToOptions", () => {
  test("only a field marked inLine option takes an option's text; other text keeps its own lines", () => {
    const answer = { scope: { text: { max: 4000 }, inLine: "option" as const }, text: { text: { max: 4000 } } };
    const packet = { question: "q", blocks: [], options: [{ id: "a", label: "A", fill: { scope: "One two.", text: "Yes, go." } }, { id: "b", label: "B", fill: {} }] };
    expect(snapToOptions(answer, { scope: " One\ntwo. ", text: "Yes,\ngo." }, packet)).toEqual({ scope: "One two.", text: "Yes,\ngo." });
    expect(snapToOptions(answer, { scope: "Three." }, packet)).toEqual({ scope: "Three." });
  });
});

describe("decision log", () => {
  test("decisions.jsonl is rebuilt from events.jsonl when a line is missing or doubled", async () => {
    const dir = tempDir();
    const a = engine(dir);
    for (const t of ["t1", "t2"]) {
      const c = await fileAndPrepare(a.e, t);
      a.e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1" } });
    }
    const file = join(dir, "decisions.jsonl");
    const good = readFileSync(file, "utf8");
    expect(good.trim().split("\n")).toHaveLength(2);
    const [l1] = good.trim().split("\n");
    writeFileSync(file, `${l1}\n${l1}\n`);
    const b = engine(dir, { clock: a.clock });
    expect(b.e.decisions.rebuilt).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(good);
  });

  test("precedent: own policy, Nil's calls only, newest first, no undone line, no recommended mark", async () => {
    const { e } = engine(tempDir());
    const c1 = await fileAndPrepare(e, "t1");
    e.decide(MEMBER, c1.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const c2 = await fileAndPrepare(e, "t2");
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "backlog", priority: null } });
    const c3 = await fileAndPrepare(e, "t3");
    e.decide(MEMBER, c3.id, { version: 1, call: { choice: "go", priority: "P2" } });
    e.undo(MEMBER, c3.id);
    const p = e.decisions.precedent("triage");
    expect(p.map((l) => l.subject)).toEqual(["t2", "t1"]);
    expect(p.every((l) => l.snapshot.recommended === null)).toBe(true);
    expect(e.decisions.precedent("command-failed")).toEqual([]);
    // The full line keeps everything for audit.
    expect(e.decisions.all().some((l) => "undoes" in l)).toBe(true);
  });
});
