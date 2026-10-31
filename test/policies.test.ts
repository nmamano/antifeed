import { afterAll, describe, expect, test } from "bun:test";
import { checkProject, loadProjects } from "../src/policies";
import fake from "./fixtures/isomux/policies";
import { FIXTURE, cleanup } from "./helpers";

afterAll(cleanup);

const triage = fake.policies[0];
const withPolicy = (p: object, rest: object = {}) => ({ ...fake, ...rest, policies: [{ ...triage, ...p }] });

describe("load check", () => {
  test("the fixture project loads", async () => {
    expect(checkProject(fake)).toEqual([]);
    const r = await loadProjects([FIXTURE, "/nonexistent/policies.ts"]);
    expect(r.loaded.map((l) => l.def.project)).toEqual(["isomux"]);
    expect(r.loaded[0].hash).toMatch(/^[0-9a-f]{12}$/);
    expect(r.refused[0].problems[0]).toMatch(/cannot load/);
  });

  test("the demo project loads", async () => {
    const r = await loadProjects([new URL("../projects/demo/policies.ts", import.meta.url).pathname]);
    expect(r.refused).toEqual([]);
  });

  test.each([
    ["an emitted event with no subscriber that is not final", withPolicy({ final: [] }), /"triage.decided".*no subscriber/],
    ["a subscribed event with no emitter", withPolicy({ on: [...triage.on, "github.pr.opened"] }), /"github.pr.opened".*no emitter/],
    ["a command to an unknown actor", withPolicy({ commands: { x: { actor: "main", delivery: "at-most-once" } } }), /unknown actor "main"/],
    ["a command with no delivery rule", withPolicy({ commands: { x: { actor: "curator" } } }), /needs delivery/],
    ["an emit of a generic type", withPolicy({ emits: ["card.decided"] }), /generic type/],
    ["a code decider with no handler", withPolicy({ decider: { kind: "code", handler: "guess" } }), /unknown handler "guess"/],
    ["a threshold out of range", withPolicy({ decider: { kind: "threshold", agent: { kind: "agent", model: "m", criteria: "c" }, min: 1.5 } }), /min must be/],
    ["a decider with no answer schema", withPolicy({ answer: undefined, primary: [] }), /needs an answer schema/],
    ["a project event declared with a generic prefix", { ...fake, events: { ...fake.events, "clock.fake": { from: "board" } } }, /generic prefix/],
    // Engine.inputs folds input.* from any project: a project may not declare them (Antifeed Reviewer on 8a23a90).
    ["a project event declared as input.*", { ...fake, events: { ...fake.events, "input.filed": { from: "board" } } }, /generic prefix/],
    ["a project event declared as chat.*", { ...fake, events: { ...fake.events, "chat.answered": { from: "board" } } }, /generic prefix/],
  ])("refuses %s", (_n, def, why) => {
    expect(checkProject(def as never).join("\n")).toMatch(why);
  });
});
