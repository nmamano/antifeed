import { afterAll, describe, expect, test } from "bun:test";
import { CALL_HOLD_MS, Dispatcher } from "../src/dispatcher";
import { nullOffice } from "../src/office";
import type { Policy } from "../src/types";
import { FakeOffice } from "./fake-office";
import fakeDef from "./fixtures/isomux/policies";
import { engine, fileAndPrepare, MEMBER, packet, project, tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const filed = (e: ReturnType<typeof engine>["e"], id: string) =>
  e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: id, data: { title: "A", priority: "P1" } });

describe("dispatcher", () => {
  test("a prepare goes at once; an apply waits for a quiet burst; one message per actor", async () => {
    const office = new FakeOffice();
    const { e, clock } = engine(tempDir());
    const d = new Dispatcher(e, office, "http://127.0.0.1:1", () => clock.t);
    const card = await fileAndPrepare(e, "t1");
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
    filed(e, "t2");
    await d.tick();
    expect(office.sent).toHaveLength(1);
    expect(office.sent[0].to).toBe("agent-curator-1");
    expect(office.sent[0].text).toContain("triage.prepare t2");
    expect(office.sent[0].text).not.toContain("triage.apply");
    clock.t += 179_000;
    await d.tick();
    expect(office.sent).toHaveLength(1);
    clock.t += 2_000;
    await d.tick();
    // The actor's skill loads with the commands.
    expect(office.sent[1].text).toMatch(/^\/isomux-curator Antifeed: 1 command\./);
    expect(office.sent[1].text).toContain("triage.apply t1");
    expect([...e.commands.values()].every((k) => k.state !== "issued")).toBe(true);
  });

  test("an agent actor with no skill gets a message with no slash", async () => {
    const office = new FakeOffice();
    const def = { ...fakeDef, actors: fakeDef.actors.map((a) => (a.kind === "agent" ? { ...a, skill: undefined } : a)) };
    const { e, clock } = engine(tempDir(), { projects: [project(def)] });
    const d = new Dispatcher(e, office, "http://127.0.0.1:1", () => clock.t);
    filed(e, "t1");
    await d.tick();
    expect(office.sent[0].text).toMatch(/^Antifeed: 1 command\./);
  });

  test("at-least-once: a failed send stays issued and goes again; delivered is logged after the send", async () => {
    const office = new FakeOffice();
    office.failSends = 1;
    const { e, clock } = engine(tempDir());
    const d = new Dispatcher(e, office, "http://127.0.0.1:1", () => clock.t);
    filed(e, "t1");
    const r = await d.tick();
    expect(r.errors[0]).toContain("502");
    expect([...e.commands.values()][0].state).toBe("issued");
    await d.tick();
    expect(office.sent).toHaveLength(1);
    expect([...e.commands.values()][0].state).toBe("delivered");
  });

  test("at-most-once: delivered before the send and never sent again", async () => {
    const push: Policy = {
      ...fakeDef.policies[0],
      commands: { ...fakeDef.policies[0].commands, "triage.push": { actor: "curator", delivery: "at-most-once", timeoutMs: 60_000 } },
      reduce: (s, ev) => (ev.type === "board.task.filed" ? { state: s, out: [{ issue: { type: "triage.push", subject: ev.subject, params: {} } }] } : { state: s }),
    };
    const office = new FakeOffice();
    office.failSends = 1;
    const { e, clock } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [push] })] });
    const d = new Dispatcher(e, office, "http://127.0.0.1:1", () => clock.t);
    filed(e, "t1");
    await d.tick();
    await d.tick();
    expect(office.sent).toHaveLength(0);
    const k = [...e.commands.values()][0];
    expect(k.state).toBe("delivered");
    // The lost message reaches its timeout and becomes a card for Nil.
    clock.t += 61_000;
    e.fireWakes();
    await e.settle();
    expect([...e.cards.values()].find((c) => c.policy === "command-failed")?.packet?.question).toContain("triage.push");
  });

  test("at start, a command older than its burst plus 10 minutes is not sent: it becomes a card", async () => {
    const dir = tempDir();
    const a = engine(dir);
    filed(a.e, "t1");
    a.clock.t += 11 * 60_000;
    const b = engine(dir, { clock: a.clock });
    const office = new FakeOffice();
    const d = new Dispatcher(b.e, office, "http://127.0.0.1:1", () => a.clock.t);
    const r = await d.tick();
    expect(r.stale).toHaveLength(1);
    expect(office.sent).toHaveLength(0);
    await b.e.settle();
    expect([...b.e.cards.values()].find((c) => c.policy === "command-failed")?.packet?.question).toContain("stale after restart");
    // A command issued during this run is not stale.
    filed(b.e, "t2");
    a.clock.t += 60 * 60_000;
    await d.tick();
    expect(office.sent).toHaveLength(1);
  });

  test("no live agent by that name, or an office that cannot send: the command waits", async () => {
    const office = new FakeOffice();
    office.roster = [];
    const { e, clock } = engine(tempDir());
    filed(e, "t1");
    const r = await new Dispatcher(e, office, "x", () => clock.t).tick();
    expect(r.errors[0]).toContain('no live agent named "Isomux Curator"');
    const r2 = await new Dispatcher(e, { ...nullOffice, agents: async () => [{ id: "a1", name: "Isomux Curator" }] }, "x", () => clock.t).tick();
    expect(r2.errors[0]).toContain("cannot send");
    expect([...e.commands.values()][0].state).toBe("issued");
  });

  test("a code actor runs in the app and reports its result", async () => {
    const def = {
      ...fakeDef,
      actors: [...fakeDef.actors, { id: "clerk", kind: "code" as const, handler: "note" }],
      run: { note: (k: { params: unknown }) => ({ echoed: k.params }) },
      policies: [{
        ...fakeDef.policies[0],
        commands: { ...fakeDef.policies[0].commands, "triage.note": { actor: "clerk", delivery: "at-least-once" as const } },
        reduce: (s: unknown, ev: { type: string }) => (ev.type === "board.task.filed" ? { state: s, out: [{ issue: { type: "triage.note", params: { n: 1 } } }] } : { state: s }),
      }],
    };
    const { e, clock } = engine(tempDir(), { projects: [project(def as never)] });
    filed(e, "t1");
    await new Dispatcher(e, new FakeOffice(), "x", () => clock.t).tick();
    expect([...e.commands.values()][0]).toMatchObject({ state: "done", result: { echoed: { n: 1 } } });
  });
});

// Round Q1, package C: a code author (the walkthrough's demo author) answers
// its policy's prepare command with {packet, meta}: the card's next version.
describe("a code author", () => {
  const withAuthor = (run: (k: any, e: any) => unknown, extra: Record<string, unknown> = {}) => {
    let eng: any;
    const def = {
      ...fakeDef,
      actors: [...fakeDef.actors.filter((a) => a.id !== "curator"), { id: "curator", kind: "code" as const, handler: "author" }, { id: "clerk", kind: "code" as const, handler: "note" }],
      run: { author: (k: unknown) => run(k, eng), note: (k: unknown) => run(k, eng) },
      ...extra,
    };
    const made = engine(tempDir(), { projects: [project(def as never)] });
    eng = made.e;
    return made;
  };
  const types = (e: any, from: number) => e.log.all().filter((x: any) => x.seq > from).map((x: any) => x.type);

  test("{packet, meta} for its prepare: card.packet at the next version and command.done, nothing more", async () => {
    const { e, clock } = withAuthor((k: any) => ({ packet: packet(), meta: { raw: `board:${k.subject}` } }));
    filed(e, "t1");
    const k = [...e.commands.values()].find((x) => x.type === "triage.prepare")!;
    const seq = e.log.all().at(-1)!.seq;
    await new Dispatcher(e, new FakeOffice(), "x", () => clock.t).tick();
    const card = [...e.cards.values()].find((c) => c.subject === "t1")!;
    expect(card.version).toBe(1);
    expect(card.packet?.question).toBe(packet().question);
    expect(e.commands.get(k.id)).toMatchObject({ state: "done" });
    // Delivered and started by the dispatcher, then the packet and the done in one write.
    expect(types(e, seq).filter((t: string) => !t.startsWith("command.delivered") && !t.startsWith("command.started") && t !== "batch.end").slice(0, 2)).toEqual(["card.packet", "command.done"]);
    expect([...e.cards.values()].some((c) => c.policy === "command-failed")).toBe(false);
  });

  test("a card withdrawn while the author runs: its prepare is done, skipped, and no failure card opens", async () => {
    const { e, clock } = withAuthor((k: any, eng: any) => {
      eng.sourceEvent({ project: "isomux", source: "board", type: "board.task.closed", subject: k.subject, data: {} });
      return { packet: packet(), meta: { raw: `board:${k.subject}` } };
    });
    filed(e, "t1");
    const k = [...e.commands.values()].find((x) => x.type === "triage.prepare")!;
    await new Dispatcher(e, new FakeOffice(), "x", () => clock.t).tick();
    const card = [...e.cards.values()].find((c) => c.subject === "t1")!;
    expect(card.state).toBe("withdrawn");
    expect(card.packet).toBeNull();
    expect(e.commands.get(k.id)).toMatchObject({ state: "done", result: { skipped: expect.stringContaining("withdrawn") } });
    expect([...e.cards.values()].some((c) => c.policy === "command-failed")).toBe(false);
  });

  test("a packet field from a command that is not the policy's prepare writes no version", async () => {
    const { e, clock } = withAuthor(
      (k: any) => (k.type === "triage.note" ? { packet: packet("Not a packet"), meta: { raw: "x" } } : { packet: packet(), meta: { raw: `board:${k.subject}` } }),
      {
        policies: [{
          ...fakeDef.policies[0],
          commands: { ...fakeDef.policies[0].commands, "triage.note": { actor: "clerk", delivery: "at-least-once" as const } },
          reduce: (st: unknown, ev: { type: string }) => (ev.type === "board.task.seen" ? { state: st, out: [{ issue: { type: "triage.note", params: {} } }] } : fakeDef.policies[0].reduce(st as never, ev as never)),
        }],
      },
    );
    filed(e, "t1");
    const d = new Dispatcher(e, new FakeOffice(), "x", () => clock.t);
    await d.tick();
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "t1", data: { title: "A", priority: "P1" } });
    await d.tick();
    const note = [...e.commands.values()].find((x) => x.type === "triage.note")!;
    expect(note).toMatchObject({ state: "done", result: { packet: { question: "Not a packet" } } });
    const card = [...e.cards.values()].find((c) => c.subject === "t1")!;
    expect(card.version).toBe(1);
    expect(card.packet?.question).toBe(packet().question);
  });
});

describe("round 9: a command of Nil's call waits for the call's Undo time", () => {
  test("it is not sent before CALL_HOLD_MS; an Undo in that time cancels it; after it, it is sent", async () => {
    const triage = { ...fakeDef.policies[0], commands: { ...fakeDef.policies[0].commands, "triage.apply": { actor: "curator", delivery: "at-least-once" as const, burstMs: 0 } } };
    const { e, clock } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [triage] })] });
    const office = new FakeOffice();
    const d = new Dispatcher(e, office, "x", () => clock.t);
    const a = await fileAndPrepare(e, "t1");
    const b = await fileAndPrepare(e, "t2");
    await d.tick();
    office.sent.length = 0;
    e.decide(MEMBER, a.id, { version: 1, call: { choice: "go", priority: "P1" } });
    e.decide(MEMBER, b.id, { version: 1, call: { choice: "go", priority: "P2" } });
    const [ka, kb] = [...e.commands.values()].filter((k) => k.type === "triage.apply");
    clock.t += CALL_HOLD_MS - 1;
    await d.tick();
    expect(office.sent).toHaveLength(0);
    e.undo(MEMBER, a.id);
    expect(e.commands.get(ka.id)!.state).toBe("cancelled");
    clock.t += 1;
    await d.tick();
    expect(office.sent.map((m) => m.text).join("\n")).toContain(kb.id);
    expect(office.sent.map((m) => m.text).join("\n")).not.toContain(ka.id);
  });
});

describe("Undo while the dispatcher waits on the office (review, slice 3)", () => {
  for (const delivery of ["at-most-once", "at-least-once"] as const)
    test(`a ${delivery} command cancelled before the send is not sent`, async () => {
      const triage = { ...fakeDef.policies[0], commands: { ...fakeDef.policies[0].commands, "triage.apply": { actor: "curator", delivery, burstMs: 0 } } };
      const { e, clock } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [triage] })] });
      const office = new FakeOffice();
      const card = await fileAndPrepare(e, "t1");
      e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
      const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
      const roster = office.roster;
      office.agents = async () => {
        e.undo(MEMBER, card.id);
        return roster;
      };
      clock.t += CALL_HOLD_MS;
      await new Dispatcher(e, office, "x", () => clock.t).tick();
      expect(e.commands.get(apply.id)!.state).toBe("cancelled");
      expect(office.sent.map((m) => m.text).join("\n")).not.toContain("triage.apply");
    });

  test("a command cancelled during the send is in the message, but its start is refused", async () => {
    const { e, clock } = engine(tempDir());
    const office = new FakeOffice();
    const card = await fileAndPrepare(e, "t1");
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    const send = office.message.bind(office);
    office.message = async (text, to) => {
      await send(text, to);
      e.undo(MEMBER, card.id);
    };
    clock.t += 200_000;
    await new Dispatcher(e, office, "x", () => clock.t).tick();
    expect(office.sent[0].text).toContain("triage.apply");
    expect(office.sent[0].text).toContain("start it (POST .../start; on 409 do not act)");
    expect(e.commands.get(apply.id)!.state).toBe("cancelled");
    expect(() => e.startCommand(apply.id)).toThrow(/already cancelled/);
  });
});


// Antifeed Reviewer's restart tests (round 9 review, moved here in round 10).
describe("round 10: a restart during the hold", () => {
  for (const delivery of ["at-least-once", "at-most-once"] as const)
    test(`a restart during the hold neither drops nor doubles a ${delivery} apply`, async () => {
      const triage = { ...fakeDef.policies[0], commands: { ...fakeDef.policies[0].commands, "triage.apply": { actor: "curator", delivery, burstMs: 0 } } };
      const projects = [project({ ...fakeDef, policies: [triage] })];
      const dir = tempDir();
      const clock = { t: Date.parse("2026-10-25T20:00:00Z") };
      const { e } = engine(dir, { clock, projects });
      const office = new FakeOffice();
      const d1 = new Dispatcher(e, office, "x", () => clock.t);
      const a = await fileAndPrepare(e, "t1");
      await d1.tick();
      office.sent.length = 0;
      e.decide(MEMBER, a.id, { version: 1, call: { choice: "go", priority: "P1" } });
      const k = [...e.commands.values()].find((x) => x.type === "triage.apply")!;
      clock.t += 10_000;
      await d1.tick();
      expect(office.sent).toHaveLength(0);
      e.close();
      // Restart: a new engine on the same log, a new dispatcher.
      const { e: e2 } = engine(dir, { clock, projects });
      const d2 = new Dispatcher(e2, office, "x", () => clock.t);
      expect(e2.commands.get(k.id)!.state).toBe("issued");
      await d2.tick();
      expect(office.sent).toHaveLength(0);
      clock.t += CALL_HOLD_MS - 10_000 - 1;
      await d2.tick();
      expect(office.sent).toHaveLength(0);
      clock.t += 1;
      await d2.tick();
      await d2.tick();
      clock.t += 60_000;
      await d2.tick();
      const n = office.sent.filter((m) => m.text.includes(k.id)).length;
      expect(n).toBe(1);
      e2.close();
    });

  test("an Undo after a restart inside the hold cancels, and nothing is sent", async () => {
    const triage = { ...fakeDef.policies[0], commands: { ...fakeDef.policies[0].commands, "triage.apply": { actor: "curator", delivery: "at-least-once" as const, burstMs: 0 } } };
    const projects = [project({ ...fakeDef, policies: [triage] })];
    const dir = tempDir();
    const clock = { t: Date.parse("2026-10-25T20:00:00Z") };
    const { e } = engine(dir, { clock, projects });
    const office = new FakeOffice();
    const a = await fileAndPrepare(e, "t1");
    await new Dispatcher(e, office, "x", () => clock.t).tick();
    office.sent.length = 0;
    e.decide(MEMBER, a.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const k = [...e.commands.values()].find((x) => x.type === "triage.apply")!;
    clock.t += 5_000;
    e.close();
    const { e: e2 } = engine(dir, { clock, projects });
    e2.undo(MEMBER, a.id);
    expect(e2.commands.get(k.id)!.state).toBe("cancelled");
    clock.t += CALL_HOLD_MS;
    await new Dispatcher(e2, office, "x", () => clock.t).tick();
    expect(office.sent.filter((m) => m.text.includes(k.id))).toHaveLength(0);
    e2.close();
  });

  test("heldUntil names each held command of a call with its send time, and drops it once sent", async () => {
    const triage = { ...fakeDef.policies[0], commands: { ...fakeDef.policies[0].commands, "triage.apply": { actor: "curator", delivery: "at-least-once" as const, burstMs: 0 } } };
    const { e, clock } = engine(tempDir(), { projects: [project({ ...fakeDef, policies: [triage] })] });
    const office = new FakeOffice();
    const d = new Dispatcher(e, office, "x", () => clock.t);
    const a = await fileAndPrepare(e, "t1");
    await d.tick();
    e.decide(MEMBER, a.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const k = [...e.commands.values()].find((x) => x.type === "triage.apply")!;
    expect(d.heldUntil()).toEqual({ [k.id]: new Date(Date.parse(k.issuedAt) + CALL_HOLD_MS).toISOString() });
    clock.t += CALL_HOLD_MS;
    await d.tick();
    expect(d.heldUntil()).toEqual({});
  });
});
