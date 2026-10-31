// Slice 8, Wall Game triage (DESIGN.md section 16): the Wall Game board's
// tasks as cards, and Nil's calls to Wall Game PM in one message per burst.
import { afterAll, describe, expect, test } from "bun:test";
import { BoardSource } from "../src/board";
import { CALL_HOLD_MS, Dispatcher } from "../src/dispatcher";
import { folderHash } from "../src/policies";
import wallgame, { WALLGAME_PM_ID, WALLGAME_ROOM } from "../projects/wallgame/policies";
import { boardLine, callLines, landed, messageBlock, messageText, NOT_SENT_CHANGED, UNDO_WORDS, whyNot, type WTask } from "../projects/wallgame/triage";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";
import { httpOffice } from "../src/office";
import { makeApi, MEMBER_HEADER } from "../src/api";
import { Blobs } from "../src/blobs";
import { buildView } from "../src/view";

afterAll(cleanup);

const PATH = new URL("../projects/wallgame/policies.ts", import.meta.url).pathname;
const BURST = 180_000;

function setup(dir = tempDir(), clock?: { t: number }) {
  const fp = fakePredict();
  const x = engine(dir, { projects: [{ def: wallgame, path: PATH, hash: folderHash(PATH) }], predict: fp.rt, clock });
  const office = new FakeOffice();
  // F4: an agent of the same name in another room never gets the calls.
  office.roster = [
    { id: "agent-other-pm", name: "Wall Game PM", roomId: "e6818e47", roomName: "Isomux" },
    { id: WALLGAME_PM_ID, name: "Wall Game PM", roomId: WALLGAME_ROOM, roomName: "Wall Game" },
  ];
  const src = new BoardSource(x.e, office, "wallgame", "board", WALLGAME_ROOM);
  const d = new Dispatcher(x.e, office, "http://127.0.0.1:21042", () => x.clock.t);
  const put = (id: string, t: Partial<Parameters<FakeOffice["put"]>[0]> = {}) => office.put({ id, roomId: WALLGAME_ROOM, description: "", ...t });
  return { ...x, office, src, d, put };
}
type S = ReturnType<typeof setup>;
const cardsOf = (s: S, task: string) => [...s.e.cards.values()].filter((c) => c.subject === task);
const live = (s: S, task: string) => cardsOf(s, task).find((c) => c.state !== "withdrawn");
// The card that waits for Nil: neither withdrawn nor decided.
const openOf = (s: S, task: string) => cardsOf(s, task).find((c) => c.state !== "withdrawn" && c.state !== "decided");
// The consult's Premove, so the card is open.
async function premove(s: S, cardId: string, call: Record<string, string | null> = { choice: "go", priority: "P2" }) {
  await s.e.settle();
  const k = [...s.e.commands.values()].filter((x) => x.type === "predict" && x.card === cardId).at(-1)!;
  s.e.startCommand(k.id);
  s.e.predictionResult(k.id, { call, confidence: 0.7, why: "w", against: "a" });
}
// Past the call's Undo time and the burst: the message goes.
async function flush(s: S) {
  s.clock.t += CALL_HOLD_MS + BURST + 1_000;
  return s.d.tick();
}
const task = (t: Partial<WTask> = {}): WTask => ({ title: "T", priority: "P2", status: "open", assignee: null, description: "", createdBy: "", createdAt: 0, ...t });

describe("which tasks get a card", () => {
  test("open, P0-P3 or no priority, no assignee, no call line; a report line of Nil's is not a call", () => {
    expect(whyNot(task())).toBeNull();
    expect(whyNot(task({ priority: null }))).toBeNull();
    expect(whyNot(task({ description: "Nil, 2026-07-29: after beating a campaign level, the list shows old stars." }))).toBeNull();
    expect(whyNot(task({ description: "DECISIONS (Nil, 2026-10-25):\n- render on the 4090" }))).toBeNull();
    expect(whyNot(task({ description: "Some text.\nNil, 2026-10-26: go P1. First." }))).toBe("Nil decided it on the board.");
    expect(whyNot(task({ description: "nil, 2026-10-26: Obsolete." }))).toBe("Nil decided it on the board.");
    expect(whyNot(task({ status: "in_progress" }))).toBe("The task is in progress on the board.");
    expect(whyNot(task({ assignee: "Wall Game Worker 1" }))).toBe("Wall Game Worker 1 took the task on the board.");
    expect(whyNot(task({ priority: "P4" }))).toBe("The task moved to P4 on the board.");
    expect(whyNot(task({ status: "done" }))).toBe("The task was closed on the board.");
    expect(whyNot(task({ status: "gone" }))).toBe("The task left the Wall Game board.");
  });

  test("the first read opens a card for each task that qualifies; later reads only for new ones", async () => {
    const s = setup();
    s.put("a", { title: "A bug Nil found", description: "Nil, 2026-07-29: the level list shows old stars." });
    s.put("b", { title: "No priority", priority: null });
    s.put("c", { title: "Claimed", assignee: "Wall Game Worker 3" });
    s.put("d", { title: "In progress", status: "in_progress" });
    s.put("e", { title: "Decided on the board", description: "Nil, 2026-10-20: backlog. Not now." });
    s.put("f", { title: "Backlog", priority: "P4" });
    await s.src.poll();
    expect([...s.e.cards.values()].map((c) => c.subject).sort()).toEqual(["a", "b"]);
    const a = live(s, "a")!;
    expect(a.packet!.question).toBe("A bug Nil found");
    expect(a.packet!.blocks[0]).toMatchObject({ type: "markdown", text: expect.stringContaining("Priority on the board: P2. Task a.") });
    expect(a.meta).toMatchObject({ source: "Wall Game board", raw: "https://office.example.com" });
    s.put("g", { title: "New" });
    await s.src.poll();
    expect(live(s, "g")).toBeDefined();
    expect([...s.e.cards.values()]).toHaveLength(3);
  });

  test("a waiting card withdraws with its reason; a changed task gets a new card", async () => {
    const s = setup();
    for (const id of ["a", "b", "c"]) s.put(id, { title: id.toUpperCase() });
    await s.src.poll();
    for (const id of ["a", "b", "c"]) await premove(s, live(s, id)!.id);
    const before = Object.fromEntries(["a", "b", "c"].map((id) => [id, live(s, id)!.id]));
    s.put("a", { assignee: "Wall Game Worker 2" });
    s.put("b", { description: "Nil, 2026-10-26: hold P2. After the season." });
    s.put("c", { description: "New words." });
    await s.src.poll();
    const reason = (id: string) => [...s.e.log.all()].find((x) => x.type === "card.withdrawn" && x.card === before[id])?.data?.reason;
    expect(reason("a")).toBe("Wall Game Worker 2 took the task on the board.");
    expect(reason("b")).toBe("Nil decided it on the board.");
    expect(reason("c")).toBe("The task changed on the board: a new card shows it as it is now.");
    expect(live(s, "c")!.id).not.toBe(before.c);
  });

  test("F1: a call whose task no longer waits for it is not sent; a changed task's call is not sent and the task gets a new card", async () => {
    const s = setup();
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) s.put(id, { title: id.toUpperCase(), description: "Words." });
    await s.src.poll();
    for (const id of ids) await premove(s, live(s, id)!.id);
    const card = Object.fromEntries(ids.map((id) => [id, live(s, id)!.id]));
    for (const id of ids) s.e.decide(MEMBER, card[id], { version: 1, call: { choice: "go", priority: "P1" } });
    // Inside the burst, the board changes; the board source reads it.
    s.put("a", { assignee: "Wall Game Worker 2" });
    s.put("b", { status: "done" });
    s.put("c", { priority: "P4" });
    s.put("d", { description: "Nil, 2026-10-26: hold P2.\nWords." });
    s.put("e", { description: "New words." });
    await s.src.poll();
    const apply = (id: string) => [...s.e.commands.values()].find((k) => k.type === "wallgame.apply" && k.card === card[id])!;
    expect(ids.map((id) => [apply(id).state, apply(id).cancelReason ?? null])).toEqual([
      ["cancelled", "Not sent. Wall Game Worker 2 took the task on the board."],
      ["cancelled", "Not sent. The task was closed on the board."],
      ["cancelled", "Not sent. The task moved to P4 on the board."],
      ["cancelled", "Not sent. Nil decided it on the board."],
      ["cancelled", NOT_SENT_CHANGED],
      ["issued", null],
    ]);
    // The changed task has a new card, as it is now; the others get none.
    expect(openOf(s, "e")!.id).not.toBe(card.e);
    expect(openOf(s, "e")!.packet!.blocks[1]).toEqual({ type: "markdown", text: "New words." });
    for (const id of ["a", "b", "c", "d"]) expect(cardsOf(s, id)).toHaveLength(1);
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    expect(s.office.sent[0].text).toContain('f "F"');
    expect(s.office.sent[0].text).not.toMatch(/^[a-e] "/m);
    // Unclaimed again: the task gets a new card.
    s.put("a", { assignee: null });
    await s.src.poll();
    expect(cardsOf(s, "a")).toHaveLength(2);
  });

  test("F1: just before the send, a new read of each task drops a call whose task changed or left the room", async () => {
    const s = setup();
    for (const id of ["a", "b", "c"]) s.put(id, { title: id.toUpperCase(), description: "Words." });
    await s.src.poll();
    for (const id of ["a", "b", "c"]) await premove(s, live(s, id)!.id);
    const card = Object.fromEntries(["a", "b", "c"].map((id) => [id, live(s, id)!.id]));
    for (const id of ["a", "b", "c"]) s.e.decide(MEMBER, card[id], { version: 1, call: { choice: "go", priority: "P2" } });
    // The board changes after the last read of the board source.
    s.put("a", { title: "A, now bigger" });
    s.put("b", { roomId: "e6818e47" });
    s.office.reads = [];
    await flush(s);
    expect(s.office.reads.sort()).toEqual(["a", "b", "c"]);
    expect(s.office.sent).toHaveLength(1);
    expect(s.office.sent[0].text).toMatch(/^Antifeed: the Antifeed app sends you 1 triage call that Nil made/);
    expect(s.office.sent[0].text).toContain('c "C"');
    const apply = (id: string) => [...s.e.commands.values()].find((k) => k.type === "wallgame.apply" && k.card === card[id])!;
    expect(apply("a").result).toEqual({ notSent: NOT_SENT_CHANGED });
    expect(apply("b").result).toEqual({ notSent: "Not sent. The task left the Wall Game board." });
    expect(apply("c").result).toEqual({ sent: true, to: WALLGAME_PM_ID });
    const landing = wallgame.policies[0].landing!(s.e.state("wallgame-triage"));
    expect(landing.map((l) => l.subject)).toEqual(["c"]);
    // The board source sees the change: a new card for a.
    await s.src.poll();
    expect(openOf(s, "a")!.id).not.toBe(card.a);
    expect(openOf(s, "a")!.packet!.question).toBe("A, now bigger");
  });
});

describe("the call goes to Wall Game PM", () => {
  test("one message per burst, after the Undo time; an Undo before it goes takes the call out; after it, Undo is refused", async () => {
    const s = setup();
    s.put("a", { title: "First" });
    s.put("b", { title: "Second" });
    s.put("c", { title: "Third" });
    await s.src.poll();
    for (const id of ["a", "b", "c"]) await premove(s, live(s, id)!.id);
    const [a, b, c] = ["a", "b", "c"].map((id) => live(s, id)!.id);
    s.e.decide(MEMBER, a, { version: 1, call: { choice: "go", priority: "P1", note: "This one first.\nThen the bots." } });
    s.clock.t += 60_000;
    s.e.decide(MEMBER, b, { version: 1, call: { choice: "obsolete", priority: null } });
    s.e.decide(MEMBER, c, { version: 1, call: { choice: "backlog", priority: null } });
    // Inside the burst: nothing goes, and an Undo still works.
    s.clock.t += CALL_HOLD_MS + 60_000;
    await s.d.tick();
    expect(s.office.sent).toHaveLength(0);
    s.e.undo(MEMBER, c);
    expect(s.e.cards.get(c)!.state).toBe("open");
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    const m = s.office.sent[0];
    expect(m.to).toBe(WALLGAME_PM_ID);
    expect(m.text).toMatch(/^Antifeed: the Antifeed app sends you 2 triage calls that Nil made in Antifeed \(his decision queue\) on Wall Game tasks\. Nil did not write this message\./);
    expect(m.text).toContain(`a "First"\nCall: go P1 (Nil, 2026-10-26 9:00 AM PT)\nNote: This one first.\n  Then the bots.\nBoard line: Nil, 2026-10-26: go P1. This one first.\n  Then the bots.\nCheck: curl -s http://127.0.0.1:21042/api/cards/${a}/context`);
    expect(m.text).toContain(`b "Second"\nCall: obsolete (Nil, 2026-10-26 9:01 AM PT)\nNote: none\nBoard line: Nil, 2026-10-26: obsolete.`);
    expect(m.text).not.toContain('"Third"');
    expect(() => s.e.undo(MEMBER, a)).toThrow(UNDO_WORDS);
    // The undone card is open again, with its task.
    expect(live(s, "c")!.id).toBe(c);
  });

  test("Status: a sent call lands when its call line is on the board, not before; a task whose call has not landed gets no new card", async () => {
    const s = setup();
    s.put("a", { title: "First", description: "Old words." });
    await s.src.poll();
    const a = live(s, "a")!.id;
    await premove(s, a);
    s.e.decide(MEMBER, a, { version: 1, call: { choice: "go", priority: "P1" } });
    await flush(s);
    const landing = () => wallgame.policies[0].landing!(s.e.state("wallgame-triage"));
    expect(landing()).toEqual([{ card: a, subject: "a", title: "First", call: "go P1", to: "Wall Game PM", sentAt: expect.any(String), landedAt: null }]);
    // Wall Game PM changes the priority first: no new card, not landed.
    s.put("a", { priority: "P1" });
    await s.src.poll();
    expect(cardsOf(s, "a")).toHaveLength(1);
    expect(landing()[0].landedAt).toBeNull();
    // A line with another call, or an older date, is not this call.
    s.put("a", { description: "Nil, 2026-10-26: hold P1.\nNil, 2026-10-25: go P1.\nOld words." });
    await s.src.poll();
    expect(landing()[0].landedAt).toBeNull();
    s.put("a", { description: "Nil, 2026-10-26: go P1.\n\nOld words." });
    await s.src.poll();
    expect(landing()[0].landedAt).toBe(new Date(s.clock.t).toISOString());
    expect(cardsOf(s, "a")).toHaveLength(1);
  });

  test("the line helpers: board line, call lines, landed", () => {
    const at = "2026-10-27T06:30:00Z"; // 2026-10-26 11:30 PM PT
    expect(boardLine({ choice: "design", priority: "P2", note: " Plan first. " }, at)).toBe("Nil, 2026-10-26: design P2. Plan first.");
    expect(callLines("x\nNil, 2026-10-26: design P2. Plan first.\nNil, 2026-07-29: the list shows old stars")).toEqual([{ date: "2026-10-26", call: "design" }]);
    expect(landed("Nil, 2026-10-26: design P2.", { choice: "design", priority: "P2" }, at)).toBe(true);
    expect(landed("Nil, 2026-10-25: design P2.", { choice: "design", priority: "P2" }, at)).toBe(false);
    expect(messageBlock({ task: "t1", title: "T", card: "c1", call: { choice: "hold", priority: "P3" }, decidedAt: at }, "http://x")).toBe(
      't1 "T"\nCall: hold P3 (Nil, 2026-10-26 11:30 PM PT)\nNote: none\nBoard line: Nil, 2026-10-26: hold P3.\nCheck: curl -s http://x/api/cards/c1/context',
    );
  });

  // Two calls decided, past the Undo time and the burst, with the given send.
  async function failing(message: (text: string, to: string) => Promise<void>, roster?: S["office"]["roster"]) {
    const s = setup();
    if (roster) s.office.roster = roster;
    s.put("a", { title: "First" });
    s.put("b", { title: "Second" });
    await s.src.poll();
    for (const id of ["a", "b"]) await premove(s, live(s, id)!.id);
    for (const id of ["a", "b"]) s.e.decide(MEMBER, live(s, id)!.id, { version: 1, call: { choice: "go", priority: "P2" } });
    const send = s.office.message.bind(s.office);
    s.office.message = message;
    const r = await flush(s);
    await s.e.settle();
    const ks = [...s.e.commands.values()].filter((k) => k.type === "wallgame.apply");
    const fails = [...s.e.cards.values()].filter((c) => c.policy === "command-failed");
    return { s, r, ks, fails, send };
  }
  const answered = (n: number) => async () => {
    throw new Error(`POST /api/app/message answered ${n}`);
  };

  test("F3: a failed send fails every call of the message, with one card for the burst; its retry sends them together again", async () => {
    const { s, r, ks, fails, send } = await failing(answered(400));
    expect(r.errors).toHaveLength(1);
    expect(ks.map((k) => [k.state, k.error, k.detail, !!k.blocked, !!k.maybeSent])).toEqual([
      ["failed", "the office refused the message, so nothing was sent", "POST /api/app/message answered 400", false, false],
      ["failed", "the office refused the message, so nothing was sent", "POST /api/app/message answered 400", false, false],
    ]);
    expect(fails).toHaveLength(1);
    const f = fails[0];
    // Slice 8 walk: Nil's words only; the ids and the raw cause are in the fold; the buttons match the words.
    expect(f.packet!.question).toBe("Your 2 calls to Wall Game PM did not go out. The office refused the message, so nothing was sent.");
    expect(f.packet!.blocks.slice(0, 2)).toEqual([
      { type: "fields", rows: [["Task", "First"], ["Your call", "go P2"]] },
      { type: "fields", rows: [["Task", "Second"], ["Your call", "go P2"]] },
    ]);
    expect(JSON.stringify(f.packet!.blocks[2])).toContain('["Cause","POST /api/app/message answered 400"]');
    expect(JSON.stringify(f.packet!.blocks[2])).toContain('["Task","a"]');
    expect(f.packet!.options!.map((o) => o.label)).toEqual(["Send them again", "Drop them"]);
    expect(f.packet!.limit).toEqual({ choice: ["retry", "drop"], actor: null });
    expect(() => s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "reassign", actor: "nil" } })).toThrow("choice must be one of retry, drop on this card");
    expect(f.prediction).toMatchObject({ call: { choice: "retry" } });
    s.office.message = send;
    s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "retry" } });
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    expect(s.office.sent[0].text).toMatch(/sends you 2 triage calls/);
    expect([...s.e.commands.values()].filter((k) => k.type === "wallgame.apply").map((k) => k.state)).toEqual(["failed", "failed", "done", "done"]);
  });

  test("F2: a 403 and a 404 are blocked; no answer or a 5xx may have gone out; each has drop as its Premove", async () => {
    const cases: [(t: string, to: string) => Promise<void>, RegExp, "blocked" | "maybe"][] = [
      [answered(403), /^the Antifeed app has no live owner agent in the office \(set one on the Apps page\), so the office refused it$/, "blocked"],
      [answered(404), /^the office found no Wall Game PM to send to, so nothing was sent$/, "blocked"],
      [answered(502), /^the office gave no clear answer; check with Wall Game PM before you send them again$/, "maybe"],
      [async () => { throw new TypeError("fetch failed"); }, /^the office gave no clear answer; check with Wall Game PM before you send them again$/, "maybe"],
    ];
    for (const [message, error, kind] of cases) {
      const { s, ks, fails } = await failing(message);
      expect(ks.map((k) => k.state)).toEqual(["failed", "failed"]);
      expect(ks[0].error).toMatch(error);
      expect([!!ks[0].blocked, !!ks[0].maybeSent]).toEqual([kind === "blocked", kind === "maybe"]);
      expect(fails).toHaveLength(1);
      expect(fails[0].packet!.question).toContain(kind === "maybe" ? "Your 2 calls to Wall Game PM may not have gone out." : "Your 2 calls to Wall Game PM did not go out.");
      expect(JSON.stringify(fails[0].packet!.blocks)).toContain(kind === "maybe" ? "They may have gone out, so a new try may send them twice. Check first, then pick Send them again or Drop them." : "fails the same way while this cause holds. Once it is fixed, pick Send them again.");
      // Walk 2: the Premove's words name the card's button, for both calls.
      expect(s.e.cards.get(fails[0].id)!.prediction).toMatchObject({ call: { choice: "drop" }, against: kind === "maybe" ? "If the agent says it got nothing, Send them again sends them once." : "Once you fix the cause, Send them again sends them." });
    }
  });

  test("F4: Wall Game PM by its id, live in the Wall Game room; otherwise nothing goes out, blocked", async () => {
    for (const roster of [[{ id: "agent-x", name: "Wall Game PM", roomId: WALLGAME_ROOM }], [{ id: WALLGAME_PM_ID, name: "Wall Game PM", roomId: "e6818e47" }]]) {
      const { s, ks, fails } = await failing(async () => {
        throw new Error("no send expected");
      }, roster);
      expect(s.office.sent).toHaveLength(0);
      expect(ks[0]).toMatchObject({ state: "failed", blocked: true, error: "Wall Game PM is not a live agent in the Wall Game room, so nothing was sent", detail: expect.stringContaining("WALLGAME_PM_ID") });
      expect(s.e.cards.get(fails[0].id)!.prediction).toMatchObject({ call: { choice: "drop" } });
    }
    // With an agent of the same name in another room, the calls go to the id.
    const s = setup();
    s.put("a");
    await s.src.poll();
    await premove(s, live(s, "a")!.id);
    s.e.decide(MEMBER, live(s, "a")!.id, { version: 1, call: { choice: "hold", priority: "P3" } });
    await flush(s);
    expect(s.office.sent.map((m) => m.to)).toEqual([WALLGAME_PM_ID]);
  });

  test("B1: a dropped failed call frees its task: a new card opens if the task still waits, and its board line withdraws it", async () => {
    for (const n of [400, 403, 502]) {
      const { s, fails } = await failing(answered(n));
      // While the failure card waits, a change opens no card: the call may still be retried.
      s.put("a", { description: "More words." });
      await s.src.poll();
      expect(cardsOf(s, "a").map((c) => c.state)).toEqual(["decided"]);
      // Walk 2: a drop keeps the Undo time. Inside it, nothing opens and Undo brings the failure card back whole.
      const dropped = () => [...s.e.log.all()].filter((x) => x.type === "command.dropped");
      s.e.decide(MEMBER, fails[0].id, { version: fails[0].version, call: { choice: "drop" } });
      await s.e.settle();
      expect(dropped()).toHaveLength(0);
      expect(openOf(s, "a")).toBeUndefined();
      s.clock.t += CALL_HOLD_MS - 1_000;
      s.e.fireWakes();
      await s.e.settle();
      expect(dropped()).toHaveLength(0);
      s.e.undo(MEMBER, fails[0].id);
      expect(s.e.cards.get(fails[0].id)!.state).toBe("open");
      s.clock.t += CALL_HOLD_MS + 1_000;
      s.e.fireWakes();
      await s.e.settle();
      expect(dropped()).toHaveLength(0);
      expect(openOf(s, "a")).toBeUndefined();
      // Its Undo time ends: the tasks are free, and the drop cannot be taken back.
      const v = s.e.cards.get(fails[0].id)!.version;
      s.e.decide(MEMBER, fails[0].id, { version: v, call: { choice: "drop" } });
      s.clock.t += CALL_HOLD_MS + 1_000;
      s.e.fireWakes();
      await s.e.settle();
      expect(dropped()).toHaveLength(2);
      expect(() => s.e.undo(MEMBER, fails[0].id)).toThrow("Your drop freed their tasks already; it cannot be taken back.");
      expect(openOf(s, "a")!.packet!.blocks[1]).toEqual({ type: "markdown", text: "More words." });
      expect(openOf(s, "b")).toBeDefined();
      // The call reached Wall Game PM after all (502): its line withdraws the new card.
      s.put("b", { description: "Nil, 2026-10-26: go P2." });
      await s.src.poll();
      expect(openOf(s, "b")).toBeUndefined();
    }
  });

  test("B1: a retry after a change on the board is not sent, and the task gets a new card at once; the old call and a new card are never both live", async () => {
    const { s, fails, send } = await failing(answered(400));
    s.put("a", { title: "First, now bigger" });
    await s.src.poll();
    s.office.message = send;
    s.e.decide(MEMBER, fails[0].id, { version: fails[0].version, call: { choice: "retry" } });
    await s.e.settle();
    expect(openOf(s, "a")).toBeUndefined();
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    expect(s.office.sent[0].text).toContain('b "Second"');
    expect(s.office.sent[0].text).not.toContain('a "First');
    const k = [...s.e.commands.values()].filter((x) => x.type === "wallgame.apply" && x.subject === "a").at(-1)!;
    expect(k.result).toEqual({ notSent: NOT_SENT_CHANGED });
    expect(openOf(s, "a")!.packet!.question).toBe("First, now bigger");
  });

  test("a message the office does not answer in time fails with no status, so the send may have gone", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const err = await httpOffice("t", `http://127.0.0.1:${server.port}`, 200).message("x", "y").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/answered/);
    } finally {
      server.stop(true);
    }
  });

  // The page's two reads, as the app serves them.
  function reads(s: S) {
    const api = makeApi({ engine: s.e, blobs: new Blobs(tempDir()), member: "m0000000", base: "http://127.0.0.1:1", view: () => buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }) });
    const get = async (path: string) => (await api(new Request(`http://127.0.0.1:1${path}`, { headers: { [MEMBER_HEADER]: "m0000000" } }))).json() as Promise<any>;
    return { view: () => get("/api/view"), status: () => get("/api/status") };
  }
  const lastSend = (v: any, card: string) => v.cards.find((c: any) => c.id === card).sends.at(-1);

  test("walk 1: once a retry went out, its call cannot be taken back, so the call reaches Wall Game PM once", async () => {
    const { s, fails, send } = await failing(answered(400));
    const f = fails[0];
    s.office.message = send;
    s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "retry" } });
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    expect(() => s.e.undo(MEMBER, f.id)).toThrow("Your call sent it again already; it cannot be taken back.");
    expect(() => s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "retry" } })).toThrow();
    await flush(s);
    expect(s.office.sent).toHaveLength(1);
    expect(s.office.sent[0].text.match(/^a "First"$/gm)).toHaveLength(1);
  });

  test("walk 1: an Undo inside the retry's hold cancels the retry, and the failed calls wait again; the next retry goes once", async () => {
    const { s, fails, send } = await failing(answered(400));
    const f = fails[0];
    s.office.message = send;
    s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "retry" } });
    s.e.undo(MEMBER, f.id);
    await s.e.settle();
    const ks = () => [...s.e.commands.values()].filter((k) => k.type === "wallgame.apply").map((k) => k.state);
    expect(ks()).toEqual(["failed", "failed", "cancelled", "cancelled"]);
    expect(s.e.cards.get(f.id)!.state).toBe("open");
    // The tasks stay held: a change opens no card while the failure card waits.
    s.put("a", { description: "More." });
    await s.src.poll();
    expect(openOf(s, "a")).toBeUndefined();
    s.e.decide(MEMBER, f.id, { version: f.version, call: { choice: "retry" } });
    await flush(s);
    expect(ks()).toEqual(["failed", "failed", "cancelled", "cancelled", "done", "done"]);
    expect(s.office.sent).toHaveLength(1);
  });

  test("walk 2: after a retry went out, the page and Status show the retry's result, for one call and for a batch; a dropped failure leaves Failed commands", async () => {
    // A batch.
    const { s, fails, send } = await failing(answered(400));
    const r = reads(s);
    const cards = ["a", "b"].map((id) => cardsOf(s, id)[0].id);
    expect((await r.status()).failed).toHaveLength(2);
    s.office.message = send;
    s.e.decide(MEMBER, fails[0].id, { version: fails[0].version, call: { choice: "retry" } });
    await flush(s);
    let v = await r.view();
    for (const c of cards) expect(lastSend(v, c)).toMatchObject({ state: "done" });
    expect(v.landing.map((l: any) => l.card).sort()).toEqual([...cards].sort());
    expect((await r.status()).failed).toHaveLength(0);
    // One call.
    const one = setup();
    one.put("a", { title: "Only" });
    await one.src.poll();
    await premove(one, live(one, "a")!.id);
    const card = live(one, "a")!.id;
    one.e.decide(MEMBER, card, { version: 1, call: { choice: "go", priority: "P2" } });
    const sendOne = one.office.message.bind(one.office);
    one.office.message = answered(502);
    await flush(one);
    await one.e.settle();
    const r1 = reads(one);
    v = await r1.view();
    expect(lastSend(v, card)).toMatchObject({ state: "failed", maybeSent: true, failCard: true });
    const f1 = [...one.e.cards.values()].find((c) => c.policy === "command-failed")!;
    expect(f1.packet!.question).toBe("Your call to Wall Game PM may not have gone out. The office gave no clear answer; check with Wall Game PM before you send it again.");
    one.office.message = sendOne;
    one.e.decide(MEMBER, f1.id, { version: f1.version, call: { choice: "retry" } });
    await flush(one);
    expect(lastSend(await r1.view(), card)).toMatchObject({ state: "done" });
    expect((await r1.status()).failed).toHaveLength(0);
    // Dropped: it leaves Failed commands, and the page says so.
    const d = await failing(answered(404));
    const rd = reads(d.s);
    d.s.e.decide(MEMBER, d.fails[0].id, { version: d.fails[0].version, call: { choice: "drop" } });
    await d.s.e.settle();
    const failCard = async () => (await rd.view()).cards.find((c: any) => c.id === d.fails[0].id);
    // Walk 2: Decided says when the drop frees the tasks, and then that it did.
    expect(await failCard()).toMatchObject({ dropping: 2 });
    d.s.clock.t += CALL_HOLD_MS + 1_000;
    d.s.e.fireWakes();
    await d.s.e.settle();
    expect(await failCard()).toMatchObject({ freed: 2 });
    expect((await failCard()).dropping).toBeUndefined();
    expect((await rd.status()).failed).toHaveLength(0);
    expect(lastSend(await rd.view(), cardsOf(d.s, "a")[0].id)).toMatchObject({ state: "failed", dropped: true });
  });

  test("walk 3: a refused read before the send is F2 too: a 403 is blocked, another cause sends nothing", async () => {
    const reject = (m: string) => async () => {
      throw new Error(m);
    };
    for (const [where, err, want] of [
      ["agents", "GET /agents answered 403", { blocked: true, error: "the Antifeed app has no live owner agent in the office (set one on the Apps page), so the office refused it" }],
      ["task", "GET /api/tasks/:id answered 403", { blocked: true, error: "the Antifeed app has no live owner agent in the office (set one on the Apps page), so the office refused it" }],
      ["task", "fetch failed", { blocked: false, error: "Antifeed could not read the Wall Game board just before the send, so nothing was sent", detail: "fetch failed" }],
    ] as const) {
      const s = setup();
      s.put("a");
      await s.src.poll();
      await premove(s, live(s, "a")!.id);
      s.e.decide(MEMBER, live(s, "a")!.id, { version: 1, call: { choice: "go", priority: "P2" } });
      (s.office as any)[where] = reject(err);
      await flush(s);
      const k = [...s.e.commands.values()].find((x) => x.type === "wallgame.apply")!;
      expect(s.office.sent).toHaveLength(0);
      expect({ blocked: !!k.blocked, error: k.error, ...("detail" in want ? { detail: k.detail } : {}) }).toEqual(want);
    }
  });

  test("the head of a message with one call speaks of one call", () => {
    const t = messageText(["x"]);
    expect(t).toMatch(/^Antifeed: the Antifeed app sends you 1 triage call that Nil made in Antifeed \(his decision queue\) on a Wall Game task\. Nil did not write this message\. Write its board line/);
    expect(t).toContain("shows Nil when the board line is there");
    expect(messageText(["x", "y"])).toContain("2 triage calls that Nil made in Antifeed (his decision queue) on Wall Game tasks. Nil did not write this message. For each, write its board line");
  });

  test("F3: a crash after the send sends nothing again; the burst gets one card that says it may have gone", async () => {
    const dir = tempDir();
    const s = setup(dir);
    for (const id of ["a", "b"]) s.put(id, { title: id.toUpperCase() });
    await s.src.poll();
    for (const id of ["a", "b"]) await premove(s, live(s, id)!.id);
    for (const id of ["a", "b"]) s.e.decide(MEMBER, live(s, id)!.id, { version: 1, call: { choice: "go", priority: "P2" } });
    // The office takes the message, and the app stops before it logs the result.
    s.office.message = async (text, to) => {
      s.office.sent.push({ text, to });
      await new Promise(() => {});
    };
    s.clock.t += CALL_HOLD_MS + BURST + 1_000;
    void s.d.tick();
    await Bun.sleep(50);
    expect(s.office.sent).toHaveLength(1);
    expect([...s.e.commands.values()].filter((k) => k.type === "wallgame.apply").map((k) => k.state)).toEqual(["started", "started"]);
    const b = setup(dir, s.clock);
    await b.e.settle();
    await b.d.tick();
    await b.e.settle();
    expect(b.office.sent).toHaveLength(0);
    const ks = [...b.e.commands.values()].filter((k) => k.type === "wallgame.apply");
    expect(ks.map((k) => [k.state, !!k.maybeSent])).toEqual([["failed", true], ["failed", true]]);
    const fails = [...b.e.cards.values()].filter((c) => c.policy === "command-failed");
    expect(fails).toHaveLength(1);
    expect(fails[0].packet!.question).toBe("Your 2 calls to Wall Game PM may not have gone out. Antifeed stopped during the send; check with Wall Game PM before you send them again.");
    expect(b.e.cards.get(fails[0].id)!.prediction).toMatchObject({ call: { choice: "drop" } });
    await b.d.tick();
    expect(b.office.sent).toHaveLength(0);
  });

  test("a restart rebuilds the same state, landing included, and sends nothing again", async () => {
    const dir = tempDir();
    const s = setup(dir);
    s.put("a", { title: "First" });
    await s.src.poll();
    await premove(s, live(s, "a")!.id);
    s.e.decide(MEMBER, live(s, "a")!.id, { version: 1, call: { choice: "go", priority: "P1" } });
    await flush(s);
    s.put("a", { description: "Nil, 2026-10-26: go P1." });
    await s.src.poll();
    const b = setup(dir, s.clock);
    await b.e.settle();
    expect(b.e.state("wallgame-triage")).toEqual(s.e.state("wallgame-triage"));
    expect(b.e.replayDiffs).toEqual([]);
    await b.d.tick();
    expect(b.office.sent).toHaveLength(0);
  });
});

// The switch (projects/isomux/SWITCH.md, 2026-10-28): isomux triage and Wall
// Game triage read a board each, with the same event types. Each opens cards
// only for its own board's tasks.
describe("with isomux triage on too", () => {
  test("each board's task gets one card, from its own project's policy", async () => {
    const ISO = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
    const isomux = (await import("../projects/isomux/policies")).default;
    const fp = fakePredict();
    const x = engine(tempDir(), { projects: [{ def: wallgame, path: PATH, hash: folderHash(PATH) }, { def: isomux, path: ISO, hash: folderHash(ISO) }], predict: fp.rt });
    const office = new FakeOffice();
    office.put({ id: "iso-1", roomId: "e6818e47", description: "" });
    office.put({ id: "wg-1", roomId: WALLGAME_ROOM, description: "" });
    for (const [p, room] of [["isomux", "e6818e47"], ["wallgame", WALLGAME_ROOM]]) await new BoardSource(x.e, office, p, "board", room).poll();
    office.put({ id: "iso-2", roomId: "e6818e47", description: "" });
    office.put({ id: "wg-2", roomId: WALLGAME_ROOM, description: "" });
    for (const [p, room] of [["isomux", "e6818e47"], ["wallgame", WALLGAME_ROOM]]) await new BoardSource(x.e, office, p, "board", room).poll();
    await x.e.settle();
    const by = (task: string) => [...x.e.cards.values()].filter((c) => c.subject === task).map((c) => c.project + "/" + c.policy);
    // The first read (seen) and a later one (filed).
    expect(by("iso-1")).toEqual(["isomux/triage"]);
    expect(by("iso-2")).toEqual(["isomux/triage"]);
    expect(by("wg-1")).toEqual(["wallgame/wallgame-triage"]);
    expect(by("wg-2")).toEqual(["wallgame/wallgame-triage"]);
  });
});
