import { afterAll, describe, expect, test } from "bun:test";
import { checkProject, folderHash } from "../src/policies";
import isomux from "../projects/isomux/policies";
import { buildView } from "../src/view";
import { classic, cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";

afterAll(cleanup);

const PATH = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const live = () => engine(tempDir(), { projects: [{ def: isomux, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
// The shape form's option rule needs the card kind every other policy has.
const liveClassic = () => engine(tempDir(), { projects: [{ def: classic(isomux), path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
// Isomux Consult answers the card's predict.
const predictFor = (e: E, card: string, call: object = { choice: "go", priority: "P2" }) => {
  const k = [...e.commands.values()].filter((x) => x.type === "predict" && x.card === card && x.state === "issued").at(-1)!;
  e.startCommand(k.id);
  e.predictionResult(k.id, { call, confidence: 0.7, why: "w", against: "a" });
  return k;
};
type E = ReturnType<typeof live>["e"];

const board = (e: E, type: string, id: string, data: object) => e.sourceEvent({ project: "isomux", source: "board", type, subject: id, data: { status: "open", ...data } });
const prepares = (e: E, id: string) => [...e.commands.values()].filter((k) => k.type === "triage.prepare" && k.subject === id);
const packet = {
  question: "Triage: the Log in button covers the footer on narrow phones",
  blocks: [{ type: "markdown" as const, text: "A person cannot tap Terms." }, { type: "draft" as const, key: "title", text: "Log in button covers the footer links on narrow phones" }],
  options: [{ id: "a", label: "Go P1", fill: { choice: "go", priority: "P1" } }, { id: "b", label: "Backlog", fill: { choice: "backlog", priority: null } }],
  recommended: "a",
};
async function cardFor(e: E, id: string) {
  const k = prepares(e, id).filter((x) => x.state === "issued").at(-1)!;
  e.startCommand(k.id);
  e.postPacket({ command: k.id, packet, meta: { raw: "https://office.example.com", effort: "S" } });
  await e.settle();
  const c = [...e.cards.values()].find((x) => x.subject === id && x.state !== "withdrawn")!;
  if (c.state === "predicting") predictFor(e, c.id);
  return c;
}

describe("isomux triage", () => {
  test("the policies file passes the load check", () => {
    expect(checkProject(isomux)).toEqual([]);
  });

  test("only open, untagged P0-P3 tasks get a card", () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix the login button", priority: "P2" });
    board(e, "board.task.seen", "t2", { title: "[go | ready] Tagged", priority: "P1" });
    board(e, "board.task.seen", "t3", { title: "Some idea", priority: "P4" });
    board(e, "board.task.seen", "t4", { title: "Being worked", priority: "P1", status: "in_progress" });
    expect([...e.cards.values()].map((c) => c.subject)).toEqual(["t1"]);
    expect(prepares(e, "t1")[0].params).toEqual({ taskId: "t1" });
  });

  test("Nil's call goes to the board; the Curator's own write does not re-prepare; Undo after the write still works", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix the login button", priority: "P2" });
    const card = await cardFor(e, "t1");
    expect(card.state).toBe("open");
    // go needs a priority, backlog takes none.
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: null } })).toThrow(/needs a priority/);
    expect(() => e.decide(MEMBER, card.id, { version: 1, call: { choice: "backlog", priority: "P2" } })).toThrow(/takes no priority/);
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "go", priority: "P1", title: "Log in button covers the footer", note: "" } });
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    expect(apply.params).toMatchObject({ taskId: "t1", call: { choice: "go", priority: "P1", title: "Log in button covers the footer" } });
    // The board shows the Curator's write before the result comes.
    e.startCommand(apply.id);
    board(e, "board.task.changed", "t1", { title: "[go | ready] Log in button covers the footer", priority: "P1" });
    expect(prepares(e, "t1")).toHaveLength(1);
    expect(e.cards.get(card.id)!.state).toBe("decided");
    e.commandResult(apply.id, { ok: true });
    // Undo after the write: the card comes back, and Nil's next call writes over it.
    e.undo(MEMBER, card.id);
    e.decide(MEMBER, card.id, { version: 1, call: { choice: "backlog", priority: null } });
    expect([...e.commands.values()].filter((k) => k.type === "triage.apply").map((k) => (k.params as { call: { choice: string } }).call.choice)).toEqual(["go", "backlog"]);
  });

  test("a change by someone else while the card waits: a new title re-prepares; a tag or a close withdraws", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix the login button", priority: "P2" });
    board(e, "board.task.seen", "t2", { title: "Old idea", priority: "P3" });
    board(e, "board.task.seen", "t3", { title: "Another", priority: "P3" });
    const c1 = await cardFor(e, "t1");
    await cardFor(e, "t2");
    await cardFor(e, "t3");
    board(e, "board.task.changed", "t1", { title: "Fix the login button on iOS", priority: "P2" });
    expect(prepares(e, "t1").at(-1)!.params).toEqual({ taskId: "t1", revise: "the task changed on the board after this packet" });
    expect(e.cards.get(c1.id)!.changedAfterPacket).toBe(true);
    // An assignee change only (same title and priority) does nothing.
    board(e, "board.task.changed", "t1", { title: "Fix the login button on iOS", priority: "P2", assignee: "x" });
    expect(prepares(e, "t1")).toHaveLength(2);
    board(e, "board.task.changed", "t2", { title: "[hold | nil] Old idea", priority: "P3" });
    board(e, "board.task.closed", "t3", { title: "Another", priority: "P3", status: "obsolete" });
    expect([...e.cards.values()].filter((c) => c.state === "withdrawn").map((c) => c.subject).sort()).toEqual(["t2", "t3"]);
    // The reason in words (Antifeed PM, 2026-10-31).
    const reason = (id: string) => e.log.all().find((x) => x.type === "card.withdrawn" && e.cards.get(x.card!)?.subject === id)!.data.reason;
    expect([reason("t2"), reason("t3")]).toEqual(["Decided on the board: [hold | nil].", "Closed on the board."]);
  });

  test("a tag on the board withdraws a card that waits for its packet or is open at a later version, with the tag in words", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Ask options", priority: null });
    board(e, "board.task.seen", "t2", { title: "Another", priority: "P2" });
    const c1 = await cardFor(e, "t1");
    // The Curator's second packet (v2), then Nil's call from chat is tagged on the board.
    board(e, "board.task.changed", "t1", { title: "Ask options, all of them", priority: null });
    const k = prepares(e, "t1").at(-1)!;
    e.postPacket({ command: k.id, packet: { question: "Ask options, all of them", blocks: [], options: [{ id: "a", label: "Go", fill: { choice: "go", priority: "P1", scope: "All of them." } }], recommended: "a" }, meta: { raw: "x" } });
    expect(e.cards.get(c1.id)!.version).toBe(2);
    board(e, "board.task.changed", "t1", { title: "[go | ready] Ask options, all of them", priority: "P1" });
    // A card with no packet yet.
    const c2 = [...e.cards.values()].find((c) => c.subject === "t2")!;
    expect(c2.state).toBe("preparing");
    board(e, "board.task.changed", "t2", { title: "[backlog | nil] Another", priority: "P2" });
    const w = (id: string) => e.log.all().find((x) => x.type === "card.withdrawn" && x.card === id)?.data.reason;
    expect([e.cards.get(c1.id)!.state, w(c1.id)]).toEqual(["withdrawn", "Decided on the board: [go | ready]."]);
    expect([e.cards.get(c2.id)!.state, w(c2.id)]).toEqual(["withdrawn", "Decided on the board: [backlog | nil]."]);
  });

  test("a prepare done with no packet withdraws its card, with the reason from its data", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "One", priority: "P2" });
    board(e, "board.task.seen", "t2", { title: "Two", priority: "P2" });
    board(e, "board.task.seen", "t3", { title: "Three", priority: "P2" });
    await e.settle();
    const cardOf = (id: string) => [...e.cards.values()].find((c) => c.subject === id)!;
    e.commandResult(prepares(e, "t1")[0].id, { ok: true, data: { skipped: "Nil decided go in chat on 2026-10-31 (through Isomux PM); written to the board" } });
    e.commandResult(prepares(e, "t2")[0].id, { ok: true });
    const w = (id: string) => e.log.all().find((x) => x.type === "card.withdrawn" && x.card === cardOf(id).id);
    expect([cardOf("t1").state, w("t1")!.data.reason, w("t1")!.by]).toEqual(["withdrawn", "No packet: Nil decided go in chat on 2026-10-31 (through Isomux PM); written to the board.", "code:engine"]);
    expect([cardOf("t2").state, w("t2")!.data.reason]).toEqual(["withdrawn", "No packet: its author finished without one."]);
    // A prepare answered with a packet is done too: its card opens.
    expect((await cardFor(e, "t3")).state).not.toBe("withdrawn");
    // The task is free: a later change that wants triage opens a new card.
    board(e, "board.task.changed", "t1", { title: "One, again", priority: "P1" });
    expect([...e.cards.values()].filter((c) => c.subject === "t1").map((c) => c.state)).toEqual(["withdrawn", "preparing"]);
    e.close();
  });

  test("L167, L57: the view lists a withdrawn card in Decided with the board event that withdrew it, and each card's filed time", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Old idea", priority: "P3", createdAt: Date.parse("2026-10-01T10:00:00Z") });
    board(e, "board.task.seen", "t2", { title: "Another", priority: "P3" });
    await cardFor(e, "t1");
    await cardFor(e, "t2");
    board(e, "board.task.changed", "t1", { title: "[hold | nil] Old idea", priority: "P3" });
    board(e, "board.task.closed", "t2", { title: "Another", priority: "P3", status: "obsolete" });
    const v = buildView({ engine: e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" });
    const w = (id: string) => v.cards.find((c) => c.subject === id && c.state === "withdrawn") as any;
    expect(w("t1").withdrawn).toMatchObject({ cause: "board.task.changed", task: { title: "[hold | nil] Old idea", priority: "P3", status: "open" } });
    expect(w("t2").withdrawn).toMatchObject({ cause: "board.task.closed", task: { status: "obsolete" } });
    expect(w("t1").decidedAt).toBe(w("t1").withdrawn.at);
    expect(w("t1").filedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(w("t2").filedAt).toBeUndefined();
  });

  test("a task that needs triage again after its call reached the board gets a new card", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    const c1 = await cardFor(e, "t1");
    e.decide(MEMBER, c1.id, { version: 1, call: { choice: "backlog", priority: null } });
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    e.startCommand(apply.id);
    e.commandResult(apply.id, { ok: true });
    board(e, "board.task.changed", "t1", { title: "Fix it", priority: "P4" });
    expect(e.cards.size).toBe(1);
    // Someone raises it again, untagged.
    board(e, "board.task.changed", "t1", { title: "Fix it", priority: "P1" });
    expect([...e.cards.values()].map((c) => c.subject)).toEqual(["t1", "t1"]);
  });

  test("Nil decides or the card is withdrawn while a re-prepare waits: the re-prepare is cancelled, no failure card", async () => {
    const { e, clock } = live();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    board(e, "board.task.seen", "t2", { title: "Other", priority: "P2" });
    const c1 = await cardFor(e, "t1");
    await cardFor(e, "t2");
    board(e, "board.task.changed", "t1", { title: "Fix it on iOS", priority: "P2" });
    board(e, "board.task.changed", "t2", { title: "Other, renamed", priority: "P2" });
    e.decide(MEMBER, c1.id, { version: 1, call: { choice: "go", priority: "P1" } });
    board(e, "board.task.closed", "t2", { title: "Other, renamed", priority: "P2", status: "obsolete" });
    expect(prepares(e, "t1").at(-1)!.state).toBe("cancelled");
    expect(prepares(e, "t2").at(-1)!.state).toBe("cancelled");
    clock.t += 3 * 3_600_000;
    e.fireWakes();
    await e.settle();
    // Only the apply, never started, reaches its timeout.
    const failed = [...e.cards.values()].filter((c) => c.policy === "command-failed").map((c) => e.commands.get(c.subject!.slice("command:".length))!.type);
    expect(failed).toEqual(["triage.apply"]);
  });

  test("Undo while the apply runs, and then the apply is done: the open card keeps its task", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    const c = await cardFor(e, "t1");
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1" } });
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply")!;
    e.delivered(apply.id);
    e.startCommand(apply.id);
    e.undo(MEMBER, c.id);
    e.commandResult(apply.id, { ok: true });
    board(e, "board.task.closed", "t1", { title: "Fix it", priority: "P2", status: "done" });
    expect(e.cards.get(c.id)!.state).toBe("withdrawn");
  });

  test("Undo cancels an apply that never wrote: a later board change is someone else's again", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    const c = await cardFor(e, "t1");
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1" } });
    e.undo(MEMBER, c.id);
    expect([...e.commands.values()].find((k) => k.type === "triage.apply")!.state).toBe("cancelled");
    board(e, "board.task.changed", "t1", { title: "Fix it on iOS", priority: "P2" });
    expect(prepares(e, "t1")).toHaveLength(2);
  });

  // Nil, 2026-10-29: the call is the task's shape. Each option fills a choice
  // and a scope (and a title when the shape needs one); the Predictor adds a priority.
  test("a shape packet: a prediction may set scope, a copy that differs in white space is the option's; the option Nil started from is compared with the Premove's", async () => {
    const { e } = liveClassic();
    const shapes = {
      question: "Fix the login button",
      blocks: [{ type: "markdown" as const, text: "Issue: the button covers the footer.\nProposal: move it up." }],
      options: [
        { id: "a", label: "As written", fill: { choice: "go", scope: "Move the button above the footer on every page.", title: null } },
        { id: "b", label: "Only the mobile menu", fill: { choice: "go", scope: "Move it only in the phone menu.", title: "Mobile menu: move the Log in button" } },
        { id: "c", label: "Design first", fill: { choice: "design", scope: "Decide where the button goes on every width.", title: null } },
      ],
      recommended: "a",
    };
    const A = shapes.options[0].fill.scope;
    const open = async (id: string, call: object = { choice: "go", priority: "P2", scope: A, title: null }, pk: Parameters<E["postPacket"]>[0]["packet"] = shapes) => {
      board(e, "board.task.seen", id, { title: "Fix the login button", priority: "P2" });
      const k = prepares(e, id).at(-1)!;
      e.startCommand(k.id);
      e.postPacket({ command: k.id, packet: pk, meta: { raw: "https://office.example.com", effort: "S" } });
      await e.settle();
      const c = [...e.cards.values()].find((x) => x.subject === id)!;
      predictFor(e, c.id, call);
      return c;
    };
    const outcome = (card: string) => e.log.all().find((x) => x.type === "card.decided" && x.card === card)!.data.outcome;
    const c1 = await open("t1", { choice: "go", priority: "P2", scope: "  Move the button above\nthe footer on every page. ", title: null });
    expect(e.cards.get(c1.id)!.prediction!.call.scope).toBe(A);
    // Same option, another priority: edited.
    e.decide(MEMBER, c1.id, { version: 1, call: { choice: "go", priority: "P1", scope: A, title: null }, option: "a" });
    expect(outcome(c1.id)).toBe("edited");
    const apply = [...e.commands.values()].find((k) => k.type === "triage.apply" && k.card === c1.id)!;
    expect(apply.params).toMatchObject({ call: { choice: "go", priority: "P1", scope: A } });
    // Same choice, another option: changed.
    const c2 = await open("t2");
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "go", priority: "P2", scope: "Move it only in the phone menu.", title: "Mobile menu: move the Log in button" }, option: "b" });
    expect(outcome(c2.id)).toBe("changed");
    expect([...e.commands.values()].find((k) => k.type === "triage.apply" && k.card === c2.id)!.params).toMatchObject({ call: { scope: "Move it only in the phone menu.", title: "Mobile menu: move the Log in button" } });
    // The Premove's option with Nil's edit of its scope: edited. As it is: matched.
    const c3 = await open("t3");
    e.decide(MEMBER, c3.id, { version: 1, call: { choice: "go", priority: "P2", scope: A + " And in the footer too.", title: null }, option: "a" });
    expect(outcome(c3.id)).toBe("edited");
    const c4 = await open("t4");
    e.decide(MEMBER, c4.id, { version: 1, call: { choice: "go", priority: "P2", scope: A, title: null }, option: "a" });
    expect(outcome(c4.id)).toBe("matched");
    // A scope from no option, against the Premove's option: changed.
    const c6 = await open("t6");
    e.decide(MEMBER, c6.id, { version: 1, call: { choice: "go", priority: "P2", scope: "Move it into the menu.", title: null } });
    expect(outcome(c6.id)).toBe("changed");
    // No option on both sides: the same text is matched, another text edited.
    const own = { choice: "go", priority: "P2", scope: "Move it into the menu.", title: null };
    const c7 = await open("t7", own);
    e.decide(MEMBER, c7.id, { version: 1, call: own });
    expect(outcome(c7.id)).toBe("matched");
    const c8 = await open("t8", own);
    e.decide(MEMBER, c8.id, { version: 1, call: { ...own, scope: "Move it into the side menu." } });
    expect(outcome(c8.id)).toBe("edited");
    // Reviewer B1: an option that fills a priority too. The Premove holds A's
    // scope at another priority; Nil confirms it as it is, with option "a"
    // or with no option (an older page): matched both times.
    const withPri = { ...shapes, options: [{ ...shapes.options[0], fill: { ...shapes.options[0].fill, priority: "P1" } }, ...shapes.options.slice(1)] };
    for (const [id, option] of [["t10", "a"], ["t11", undefined]] as const) {
      const c = await open(id, undefined, withPri);
      e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P2", scope: A, title: null }, ...(option ? { option } : {}) });
      expect(outcome(c.id)).toBe("matched");
    }
    // Antifeed PM, 2026-10-30: one option is the norm. It posts, decides and scores.
    const one = { ...shapes, options: [shapes.options[0]] };
    const c12 = await open("t12", undefined, one);
    expect(c12.packet!.options).toHaveLength(1);
    e.decide(MEMBER, c12.id, { version: 1, call: { choice: "go", priority: "P2", scope: A, title: null }, option: "a" });
    expect(outcome(c12.id)).toBe("matched");
    const c13 = await open("t13", undefined, one);
    e.decide(MEMBER, c13.id, { version: 1, call: { choice: "go", priority: "P2", scope: "Move it into the menu.", title: null } });
    expect(outcome(c13.id)).toBe("changed");
    const k0 = prepares(e, "t13").at(-1)!;
    expect(() => e.postPacket({ command: k0.id, packet: { ...shapes, options: [] }, meta: { raw: "https://office.example.com" } })).toThrow(/1 to 4 options/);
    // A scope is text of at most 4000 characters.
    const c5 = await open("t5");
    expect(() => e.decide(MEMBER, c5.id, { version: 1, call: { choice: "go", priority: "P2", scope: "x".repeat(4001) } })).toThrow(/scope must be text of at most 4000/);
  });

  // Antifeed PM, 2026-10-29: the packet shape changed, so every open card gets a new packet.
  test("reprepare: each open card gets one prepare with the revise note, 3 at a time; a decided or closed card is not asked; a replay issues nothing new", async () => {
    const dir = tempDir();
    const open = () => engine(dir, { projects: [{ def: isomux, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
    const { e } = open();
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const cards: Record<string, string> = {};
    for (const id of ids) {
      board(e, "board.task.seen", id, { title: `Task ${id}`, priority: "P2" });
      cards[id] = (await cardFor(e, id)).id;
    }
    e.decide(MEMBER, cards.t6, { version: 1, call: { choice: "backlog", priority: null } });
    expect(() => e.reprepare("triage", " ", "code:test")).toThrow(/revise must say/);
    const why = "the packet shape changed: issue, proposal, shapes";
    // A card with no earlier prepare (posted with no command) has no task id to send: skipped.
    e.postPacket({ policy: "triage", actor: "curator", subject: "t9", packet, meta: { raw: "https://office.example.com" } });
    await e.settle();
    const t9 = [...e.cards.values()].find((x) => x.subject === "t9")!;
    if (t9.state === "predicting") predictFor(e, t9.id);
    expect(e.reprepare("triage", why, "code:test")).toEqual({ cards: ["t1", "t2", "t3", "t4", "t5"].map((t) => cards[t]), skipped: [t9.id] });
    const asked = () => [...e.commands.values()].filter((k) => k.type === "triage.prepare" && (k.params as { revise?: string }).revise === why);
    expect(asked().map((k) => k.subject)).toEqual(["t1", "t2", "t3"]);
    expect(asked()[0].params).toEqual({ taskId: "t1", revise: why });
    // A second request asks no card twice.
    expect(e.reprepare("triage", why, "code:test").cards).toEqual([]);
    e.reprepareStep();
    expect(asked()).toHaveLength(3);
    // t1's new packet comes: t4 goes out. t5 leaves the board: it is not asked.
    e.startCommand(asked()[0].id);
    e.postPacket({ command: asked()[0].id, packet, meta: { raw: "https://office.example.com", effort: "S" } });
    board(e, "board.task.closed", "t5", { status: "done" });
    e.reprepareStep();
    expect(asked().map((k) => k.subject)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(e.cards.get(cards.t1)!.version).toBe(2);
    // The Curator's 409 skip ends t2's prepare; nothing is left to ask.
    e.startCommand(asked()[1].id);
    e.commandResult(asked()[1].id, { ok: true, data: { skipped: "decided" } });
    expect(e.reprepareStep()).toBe(0);
    expect(e.reprepareLeft()).toEqual([]);
    const n = e.commands.size;
    e.close();
    const again = open().e;
    expect(again.replayDiffs).toEqual([]);
    expect(again.reprepareStep()).toBe(0);
    expect(again.commands.size).toBe(n);
    // A later re-prepare (the next shape change) asks t1 again, at its new
    // version; t2 was asked at its version, t3 and t4 have a prepare out.
    expect(again.reprepare("triage", "the shape changed again", "code:test")).toEqual({ cards: [cards.t1], skipped: [t9.id] });
    again.close();
  });

  // Nil, 2026-10-29: "i should have never been shown code".
  test("plain words: a triage packet with code in the text Nil reads is refused (400); a web address, the question and a clean packet pass", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix src/x.ts line 3", priority: "P2" });
    const k = prepares(e, "t1")[0];
    e.startCommand(k.id);
    const post = (p: object) => e.postPacket({ command: k.id, packet: { question: "Fix src/x.ts line 3", blocks: [], options: [{ id: "a", label: "As written", fill: { choice: "go", scope: "Move the button." } }], recommended: "a", ...p }, meta: { raw: "https://office.example.com" } });
    const md = (text: string) => ({ blocks: [{ type: "markdown", text }] });
    const refused: [object, RegExp][] = [
      [md("Issue: the bug is in server/asks.ts."), /"server\/asks.ts" is a file path/],
      [md("See README.md for it."), /"README.md" is a file name/],
      [md("It is at line 109."), /"line 109" is a line reference/],
      [md("Lines 109-120 hold it."), /"Lines 109-120" is a line reference/],
      [md("In config.ts:12 it reads."), /"config.ts:12" is a line reference/],
      [md("Call `openAsk()` first."), /"`openAsk\(\)`" is a code span/],
      [md("Merged in 6e34332 yesterday."), /"6e34332" is a commit hash/],
      [{ blocks: [{ type: "fold", title: "Evidence", blocks: [{ type: "markdown", text: "git log: a1b2c3d4" }] }] }, /packet.blocks\[0\].blocks\[0\]: "a1b2c3d4" is a commit hash/],
      [{ options: [{ id: "a", label: "Edit app.tsx", fill: { choice: "go" } }] }, /options\[0\].label: "app.tsx" is a file name/],
      [{ options: [{ id: "a", label: "A", cost: "a day in ui/x.css", fill: { choice: "go" } }] }, /options\[0\].cost/],
      [{ options: [{ id: "a", label: "A", fill: { choice: "go", scope: "Change deploy.sh." } }] }, /options\[0\].fill.scope: "deploy.sh" is a file name/],
      [{ options: [{ id: "a", label: "A", fill: { choice: "go", scope: "x", title: "Rename `foo`" } }] }, /options\[0\].fill.title/],
      // Reviewer B1: code itself.
      [{ blocks: [{ type: "code", text: "bun run src/main.ts" }] }, /packet.blocks\[0\]: a code block is code/],
      [{ blocks: [{ type: "fold", title: "Evidence", blocks: [{ type: "diff", unified: "-a\n+b" }] }] }, /blocks\[0\].blocks\[0\]: a diff block is code/],
      [md("Before:\n```ts\nfoo(bar)\n```"), /"```" is a code block/],
      [md("It reads:\n\n    const x = 1;"), /"const x = 1;" is an indented code block/],
      // Reviewer B2: the other text Nil reads.
      [{ blocks: [{ type: "fold", title: "Evidence in src/engine.ts:12", blocks: [] }] }, /blocks\[0\].title: "src\/engine.ts:12" is a line reference/],
      [{ blocks: [{ type: "checklist", items: ["ok", "see app.tsx"] }] }, /items\[1\]: "app.tsx"/],
      [{ blocks: [{ type: "fields", rows: [["Where", "ui/x.css"]] }] }, /rows\[0\]: "ui\/x.css" is a file path/],
      [{ blocks: [{ type: "link", url: "https://x.com", label: "the a1b2c3d4 merge" }] }, /label: "a1b2c3d4" is a commit hash/],
      [{ blocks: [{ type: "file", blob: "a".repeat(64) + ".md", name: "notes" }] }, /a file block has no place on this card/],
      [{ blocks: [{ type: "image", blob: "a".repeat(64) + ".png", caption: "The menu (Menu.tsx)" }] }, /caption: "Menu.tsx" is a file name/],
      // Antifeed PM's m1: two slashes, and more extensions.
      [md("It calls /api/agents/:id/messages."), /"\/api\/agents\/:id\/messages" is a file path/],
      [md("The code in server/backends/ does it."), /"server\/backends\/" is a file path/],
      [md("Update bun.lock and Cargo.toml."), /"bun.lock" is a file name/],
      [md("The page loads client.js first."), /"client.js" is a file name/],
      // m3, accepted: a line of a page is refused too; the 400 says how to say it.
      [md("Move line 2 of the menu."), /say "the second line"/],
    ];
    for (const [p, re] of refused) {
      expect(() => post(p)).toThrow(re);
      expect(() => post(p)).toThrow(/Say it in a member's words: what they see, not where it is in the code./);
    }
    // A web address, a markdown link, plain numbers and words with a slash pass; the question is the board's title.
    // m2: a product name, a rate, versions and a web address with no http pass; a draft is Nil's own text.
    post({ blocks: [
      { type: "markdown", text: "Issue: see https://office.example.com/a/b.html and [the page](https://x.com/y.md). It costs 1000000 credits and/or more, at 3.5 times, 0.5/day, from v2.0/v3.0. It uses Next.js and Node.js. See office.example.com/nilmamano and console.cloud.google.com/auth/scopes." },
      { type: "draft", key: "note", text: "src/x.ts line 3" },
    ] });
    expect([...e.cards.values()][0].version).toBe(1);
  });

  // Nil, 2026-10-30: isomux triage cards are the Loop app's card (cardKind "loop").
  test("loop kind: the packet is the Curator's pick; the card is open while its Premove is made; outcome against the Predictor's call with no shape rule; the view has the board's task", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix the login button", priority: "P2", description: "The button covers the footer.", createdAt: 1_700_000_000_000 });
    const k = prepares(e, "t1")[0];
    e.startCommand(k.id);
    const pick = { question: "Fix the login button", blocks: [{ type: "markdown" as const, text: "A member cannot tap Terms. Small fix." }], options: [{ id: "pick", label: "P1 · go", fill: { choice: "go", priority: "P1", scope: "Move the button above the footer." } }] };
    expect(() => e.postPacket({ command: k.id, packet: pick, meta: { raw: "https://office.example.com" } })).toThrow(/your pick as an option named in recommended/);
    // Word caps (Antifeed PM, 2026-10-30): a why over 60 words, a scope over 100 words.
    const w = (n: number) => Array(n).fill("word").join(" ");
    const capped = (why: number, scope: number) => ({ ...pick, recommended: "pick", blocks: [{ type: "markdown" as const, text: w(why) }, { type: "fold" as const, title: "Evidence", blocks: [{ type: "markdown" as const, text: w(200) }] }], options: [{ ...pick.options[0], fill: { ...pick.options[0].fill, scope: w(scope) } }] });
    expect(() => e.postPacket({ command: k.id, packet: capped(61, 10), meta: { raw: "https://office.example.com" } })).toThrow(/the why is 61 words; the cap is 60/);
    expect(() => e.postPacket({ command: k.id, packet: capped(60, 101), meta: { raw: "https://office.example.com" } })).toThrow(/the scope of option "pick" is 101 words; the cap is 100/);
    // Part I: an image's caption is not the why; the plain-words check reads it.
    const img = (caption: string) => ({ type: "image" as const, blob: "a".repeat(64) + ".png", focus: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 }, caption });
    e.postPacket({ policy: "triage", actor: "curator", subject: "tcap", packet: { ...capped(60, 10), blocks: [{ type: "markdown" as const, text: w(60) }, img(w(30))] }, meta: { raw: "https://office.example.com" } });
    expect([...e.cards.values()].some((x) => x.subject === "tcap")).toBe(true);
    expect(() => e.postPacket({ command: k.id, packet: { ...capped(10, 10), blocks: [{ type: "markdown" as const, text: w(10) }, { type: "fold" as const, title: "Evidence", blocks: [img(w(31))] }] }, meta: { raw: "https://office.example.com" } })).toThrow(/an image caption is 31 words; the cap is 30/);
    expect(() => e.postPacket({ command: k.id, packet: { ...capped(60, 10), blocks: [{ type: "markdown" as const, text: w(10) }, img("The menu (Menu.tsx)")] }, meta: { raw: "https://office.example.com" } })).toThrow(/"Menu.tsx" is a file name/);
    // Reviewer nit: every text the page shows as Why counts, a checklist's items too.
    expect(() => e.postPacket({ command: k.id, packet: { ...capped(50, 10), blocks: [{ type: "markdown" as const, text: w(50) }, { type: "checklist" as const, items: [w(6), w(5)] }] }, meta: { raw: "https://office.example.com" } })).toThrow(/the why is 61 words/);
    e.postPacket({ command: k.id, packet: { ...pick, recommended: "pick" }, meta: { raw: "https://office.example.com", effort: "S" } });
    await e.settle();
    const c = [...e.cards.values()].find((x) => x.subject === "t1")!;
    expect(c.state).toBe("predicting");
    const v = buildView({ engine: e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" });
    expect((v.cards.find((x) => x.id === c.id) as any).subjectInfo).toEqual({ title: "Fix the login button", priority: "P2", description: "The button covers the footer.", createdAt: 1_700_000_000_000 });
    expect(v.policies.find((p: any) => p.id === "triage")!.cardKind).toBe("loop");
    // Only choice and priority count (PM, R1): the pick's scope is not Nil's call.
    predictFor(e, c.id, { choice: "go", priority: "P1" });
    e.decide(MEMBER, c.id, { version: 1, call: { choice: "go", priority: "P1", scope: "Move the button above the footer.", title: null } });
    expect(e.log.all().find((x) => x.type === "card.decided" && x.card === c.id)!.data.outcome).toBe("matched");
    // Nil decides before the Premove comes: the card is open to him; the late answer is refused.
    board(e, "board.task.seen", "t2", { title: "Other", priority: "P2" });
    const k2 = prepares(e, "t2")[0];
    e.startCommand(k2.id);
    e.postPacket({ command: k2.id, packet: { ...pick, recommended: "pick" }, meta: { raw: "https://office.example.com" } });
    await e.settle();
    const c2 = [...e.cards.values()].find((x) => x.subject === "t2")!;
    const p2 = [...e.commands.values()].find((x) => x.type === "predict" && x.card === c2.id)!;
    e.startCommand(p2.id);
    const call2 = { choice: "design", priority: "P2", scope: "Move the button above the footer.", title: null };
    // Nil saw the card (the page's /shown) before his call.
    e.cardShown(MEMBER, c2.id, 1);
    e.decide(MEMBER, c2.id, { version: 1, call: call2 });
    const decided = (id: string) => e.log.all().filter((x) => x.type === "card.decided" && x.card === id);
    expect(decided(c2.id)[0].data.outcome).toBe("unpredicted");
    // Reviewer B1: its predict keeps running; the answer is logged on the card, not the Premove.
    expect(e.commands.get(p2.id)!.state).toBe("started");
    e.predictionResult(p2.id, { call: { choice: "go", priority: "P1" }, confidence: 0.5, why: "w", against: "a" });
    expect(e.log.all().find((x) => x.type === "card.predicted" && x.card === c2.id)!.data).toMatchObject({ late: true, afterDecide: true });
    expect(e.cards.get(c2.id)!.prediction).toBeNull();
    expect(e.cards.get(c2.id)!.latePrediction!.call).toEqual({ choice: "go", priority: "P1" });
    expect(decided(c2.id)[0].data.outcome).toBe("unpredicted");
    // m1: after an Undo, that answer is the Premove for the next call.
    e.undo(MEMBER, c2.id);
    expect(e.cards.get(c2.id)!.prediction!.call).toEqual({ choice: "go", priority: "P1" });
    e.decide(MEMBER, c2.id, { version: 1, call: { ...call2, choice: "go", priority: "P2" } });
    expect(decided(c2.id)[1].data.outcome).toBe("edited");
    // Reviewer F1: the decision log's line has the promoted answer too.
    const lines = e.decisions.live().filter((l: any) => l.card === c2.id && !l.undo);
    // (live() leaves out the undone line.)
    expect(lines.map((l: any) => [l.outcome, l.prediction?.call ?? null])).toEqual([["edited", { choice: "go", priority: "P1" }]]);
    // m2: a rewrite while its Premove is made closes the predict.
    board(e, "board.task.seen", "t4", { title: "Fourth", priority: "P2" });
    const k4 = prepares(e, "t4")[0];
    e.startCommand(k4.id);
    e.postPacket({ command: k4.id, packet: { ...pick, recommended: "pick" }, meta: { raw: "https://office.example.com" } });
    await e.settle();
    const c4 = [...e.cards.values()].find((x) => x.subject === "t4")!;
    const p4 = [...e.commands.values()].find((x) => x.type === "predict" && x.card === c4.id)!;
    e.decide(MEMBER, c4.id, { version: 1, call: { note: "say it shorter" }, generic: { kind: "rewrite" } });
    expect(["cancelled", "failed"]).toContain(e.commands.get(p4.id)!.state);
    // A rewrite needs a note, as for every card.
    board(e, "board.task.seen", "t3", { title: "Third", priority: "P2" });
    const c3 = await cardFor(e, "t3");
    expect(() => e.decide(MEMBER, c3.id, { version: c3.version, call: { note: " " }, generic: { kind: "rewrite" } })).toThrow(/rewrite needs a note/);
  });

  // Part G (Antifeed PM, 2026-10-30): the Curator posted a corrected packet with no command and got a second card.
  test("an author post with no command for a subject with its open card is that card's new version; the author withdraws its card with a reason", async () => {
    const dir = tempDir();
    const open = () => engine(dir, { projects: [{ def: isomux, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
    const { e } = open();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    const c = await cardFor(e, "t1");
    const post = (subject: string) => e.postPacket({ policy: "triage", actor: "curator", subject, packet: { ...packet, question: "Fix it, corrected" }, meta: { raw: "https://office.example.com" } });
    const ev = post("t1");
    expect(ev.map((x) => x.type)).not.toContain("card.opened");
    expect(ev[0]).toMatchObject({ type: "card.packet", card: c.id, data: { version: 2 } });
    await e.settle();
    expect([...e.cards.values()].filter((x) => x.subject === "t1")).toHaveLength(1);
    expect(e.cards.get(c.id)!).toMatchObject({ version: 2, state: "predicting", packet: { question: "Fix it, corrected" } });
    // A new version gets its Premove as any new version does.
    predictFor(e, c.id);
    expect(e.cards.get(c.id)!.state).toBe("open");
    // Withdraw: the author only, with a reason, an open card only.
    expect(() => e.withdrawCard(c.id, { actor: "curator" })).toThrow(/reason is required/);
    expect(() => e.withdrawCard(c.id, { actor: "nil", reason: "x" })).toThrow(/never writes as a human/);
    expect(() => e.withdrawCard("c_none", { actor: "curator", reason: "x" })).toThrow(/unknown card/);
    expect(e.withdrawCard(c.id, { actor: "curator", reason: "a duplicate" }).map((x) => x.type)).toContain("card.withdrawn");
    expect(e.log.all().find((x) => x.type === "card.withdrawn" && x.card === c.id)!.data).toEqual({ reason: "a duplicate" });
    expect(e.cards.get(c.id)!.state).toBe("withdrawn");
    expect(() => e.withdrawCard(c.id, { actor: "curator", reason: "x" })).toThrow(/the card is withdrawn, not open/);
    // With no open card for the subject, a post opens a new card; a decided card is not changed.
    post("t1");
    await e.settle();
    const c2 = [...e.cards.values()].find((x) => x.subject === "t1" && x.id !== c.id)!;
    expect(c2.version).toBe(1);
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "go", priority: "P1" } });
    post("t1");
    expect([...e.cards.values()].filter((x) => x.subject === "t1")).toHaveLength(3);
    // Reviewer B1 (a): a new task's card waits for its first packet, the prepare started: the post is refused and names it.
    board(e, "board.task.seen", "t2", { title: "Other", priority: "P2" });
    const k2 = prepares(e, "t2")[0];
    e.startCommand(k2.id);
    const status = (f: () => unknown) => { try { f(); } catch (x) { return (x as { status?: number }).status; } };
    expect(status(() => post("t2"))).toBe(409);
    expect(() => post("t2")).toThrow(`answer the open prepare ${k2.id} with its command`);
    expect([...e.cards.values()].filter((x) => x.subject === "t2")).toHaveLength(1);
    // (b) After Nil's rewrite the rewrite prepare is out (issued): refused too; the command answers it.
    e.postPacket({ command: k2.id, packet, meta: { raw: "https://office.example.com" } });
    await e.settle();
    const c3 = [...e.cards.values()].find((x) => x.subject === "t2")!;
    predictFor(e, c3.id);
    e.decide(MEMBER, c3.id, { version: 1, call: { note: "say what a member sees first" }, generic: { kind: "rewrite" } });
    const k3 = prepares(e, "t2").at(-1)!;
    expect(k3.state).toBe("issued");
    expect(() => post("t2")).toThrow(`answer the open prepare ${k3.id} with its command`);
    expect(e.cards.get(c3.id)!.version).toBe(1);
    e.startCommand(k3.id);
    e.postPacket({ command: k3.id, packet, meta: { raw: "https://office.example.com" } });
    expect(e.commands.get(k3.id)!.state).toBe("done");
    expect(e.cards.get(c3.id)!.version).toBe(2);
    // With the prepare done, the post is the card's next version.
    post("t2");
    expect(e.cards.get(c3.id)!.version).toBe(3);
    e.close();
    expect(open().e.replayDiffs).toEqual([]);
  });

  test("rewrite: the engine asks the Curator again with Nil's note", async () => {
    const { e } = live();
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    const c = await cardFor(e, "t1");
    e.decide(MEMBER, c.id, { version: 1, call: { note: "say what a member sees first" }, generic: { kind: "rewrite" } });
    expect(prepares(e, "t1").at(-1)!.params).toEqual({ taskId: "t1", revise: "say what a member sees first" });
  });

  test("a rewrite that brings no new packet puts the card back to open with its old packet and the reason", async () => {
    const dir = tempDir();
    const { e } = engine(dir, { projects: [{ def: isomux, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
    board(e, "board.task.seen", "t1", { title: "Fix it", priority: "P2" });
    board(e, "board.task.seen", "t2", { title: "Fix that", priority: "P2" });
    const c1 = await cardFor(e, "t1");
    const c2 = await cardFor(e, "t2");
    const pk = structuredClone(e.cards.get(c1.id)!.packet);
    e.decide(MEMBER, c1.id, { version: 1, call: { note: "say what a member sees first" }, generic: { kind: "rewrite" } });
    e.decide(MEMBER, c2.id, { version: 1, call: { note: "shorter" }, generic: { kind: "rewrite" } });
    expect(e.cards.get(c1.id)!.state).toBe("preparing");
    e.commandResult(prepares(e, "t1").at(-1)!.id, { ok: true, data: { skipped: "Nil decided it in chat." } });
    e.commandResult(prepares(e, "t2").at(-1)!.id, { ok: true });
    const now = e.cards.get(c1.id)!;
    expect(now).toMatchObject({ state: "open", version: 1, reopened: "No new packet from Isomux Curator: Nil decided it in chat." });
    expect(now.packet).toEqual(pk);
    expect(now.decision).toBeUndefined();
    expect(e.cards.get(c2.id)!.reopened).toBe("No new packet from Isomux Curator: it finished without one.");
    // Nil can ask again; a new packet clears the line.
    e.decide(MEMBER, c1.id, { version: 1, call: { note: "again, please" }, generic: { kind: "rewrite" } });
    expect(e.cards.get(c1.id)!.reopened).toBeUndefined();
    const k = prepares(e, "t1").at(-1)!;
    e.startCommand(k.id);
    e.postPacket({ command: k.id, packet, meta: { raw: "https://office.example.com" } });
    expect(e.cards.get(c1.id)!).toMatchObject({ version: 2, state: "predicting" });
    expect(e.cards.get(c1.id)!.reopened).toBeUndefined();
    // Nil decides the reopened card as any other (its Premove stays).
    e.decide(MEMBER, c2.id, { version: 1, call: { choice: "backlog", priority: null } });
    expect(e.cards.get(c2.id)!.state).toBe("decided");
    e.close();
    expect(engine(dir, { projects: [{ def: isomux, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt }).e.replayDiffs).toEqual([]);
  });
});

// The switch dry run (2026-10-28): 1be94be4 was filed with no priority. The
// loop app's unclassified() counts such a task (all but P4), so Antifeed does too.
describe("which tasks get a triage card", () => {
  test("an untagged open task with no priority or P0-P3 does; P4, a tagged one or one in progress does not", () => {
    const { e } = live();
    board(e, "board.task.seen", "none", { title: "No priority yet", priority: null });
    board(e, "board.task.seen", "p3", { title: "A P3 task", priority: "P3" });
    board(e, "board.task.seen", "p4", { title: "A backlog task", priority: "P4" });
    board(e, "board.task.seen", "tag", { title: "[go | ready] Tagged", priority: "P1" });
    board(e, "board.task.seen", "busy", { title: "Someone works on it", priority: "P2", status: "in_progress" });
    const asked = [...e.commands.values()].filter((k) => k.type === "triage.prepare").map((k) => k.subject).sort();
    expect(asked).toEqual(["none", "p3"]);
  });
});
