// Slice 7, the Inbox (DESIGN.md section 14): Nil's asks and pages as cards,
// against the fake office, with the engine rules they need.
import { afterAll, describe, expect, test } from "bun:test";
import { Blobs } from "../src/blobs";
import { CALL_HOLD_MS, Dispatcher } from "../src/dispatcher";
import { FakeInbox } from "../src/fake-inbox";
import { ACCESS_OFF, ASKS_OFF, FILE_MAX, InboxSource, NO_OWNER, officePath, OWNERLESS } from "../src/inbox";
import { httpOffice, NIL_TOKEN, NO_NIL_TOKEN, REFUSED_RETRY_MS, SEND_MS, TOKEN_REFUSED } from "../src/office";
import { folderHash, type ProjectDef } from "../src/policies";
import inbox from "../projects/inbox/policies";
import { CHANGED, CLOSED, choiceOf, NOT_SENT_CLOSED, packetOf, questionOf } from "../projects/inbox/ask";
import { checkAgentQuestion, checkPacket, wholeTitle } from "../src/validate";
import { PAGE_ACKED_HERE, PAGE_CHANGED, PAGE_REASONS } from "../projects/inbox/page";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";

afterAll(cleanup);

const PATH = new URL("../projects/inbox/policies.ts", import.meta.url).pathname;
const load = (def: ProjectDef = inbox) => [{ def, path: PATH, hash: folderHash(PATH) }];
// The office app's Inbox has no consult agent for now (2026-10-28); most
// tests here are about the calls, so they give it one, as a project's consult
// would be.
const withConsult: ProjectDef = { ...inbox, actors: [...inbox.actors, { id: "consult", kind: "agent", agentName: "Isomux Consult" }], consult: "consult" };

function setup(over: Parameters<typeof fakePredict>[0] = {}, def: ProjectDef = withConsult) {
  const fp = fakePredict(over);
  const dir = tempDir();
  const x = engine(dir, { projects: load(def), predict: fp.rt });
  const office = new FakeOffice();
  const f = office.inbox;
  office.roster = f.roster = [{ id: "agent-w", name: "Demo Worker", roomId: "r1", roomName: "Demo" }];
  const blobs = new Blobs(dir);
  const src = new InboxSource(x.e, office, blobs, "inbox", "inbox");
  const d = new Dispatcher(x.e, office, "http://127.0.0.1:1", () => x.clock.t);
  return { ...x, dir, office, f, blobs, src, d };
}
type S = ReturnType<typeof setup>;
const cardOfAsk = (s: S, askId: string) => [...s.e.cards.values()].filter((c) => c.policy === "ask" && c.subject === askId).at(-1)!;
// The consult's Premove for a card, so the card is open.
async function premove(s: S, cardId: string, call: Record<string, string | null>) {
  await s.e.settle();
  const k = [...s.e.commands.values()].filter((x) => x.type === "predict" && x.card === cardId).at(-1)!;
  s.e.startCommand(k.id);
  s.e.predictionResult(k.id, { call, confidence: 0.7, why: "w", against: "a" });
  return s.e.cards.get(cardId)!;
}
const OPTS = { agentId: "agent-w", prompt: "Ship it now or behind a flag?\n\nThe flag costs a day.", options: ["Ship now", "Behind a flag"], recommended: "Behind a flag" };

// Nil, 2026-10-30: no question Antifeed makes or shows is ever cut.
describe("whole questions", () => {
  const long = "Make the office's Inbox file a task from an ask with the whole ask as its title, because a cut title loses the instructions it carries";
  test("an agent's question that ends in … or ... is refused; a code packet's is not", () => {
    for (const q of [long.slice(0, 119) + "…", long.slice(0, 117) + "..."]) {
      expect(checkAgentQuestion({ question: q, blocks: [] })).toBe("packet.question is cut: give the whole title");
      expect(checkPacket({ question: q, blocks: [] })).toBeNull();
    }
    expect(checkAgentQuestion({ question: long, blocks: [] })).toBeNull();
    // One long pasted line is still a question.
    expect(checkPacket({ question: "word ".repeat(2000).trim(), blocks: [] })).toBeNull();
  });
  test("an ask's question is its whole first line, however long (B2)", () => {
    expect(questionOf(`${long}. Then tell me.\nMore lines.`)).toBe(`${long}. Then tell me.`);
    expect(questionOf("We have a choice. Should I deploy A or B?")).toBe("We have a choice. Should I deploy A or B?");
    expect(questionOf("Use e.g. the blue one?")).toBe("Use e.g. the blue one?");
    expect(questionOf("1. Merge now\n2. Wait")).toBe("1. Merge now");
    expect(questionOf("Hmm... I think we should ship. Ok?")).toBe("Hmm... I think we should ship. Ok?");
  });
  test("a board title the office cut: the description's whole first line", () => {
    expect(wholeTitle(long.slice(0, 119) + "…", `\n${long}. Second sentence.\nMore.`)).toBe(`${long}. Second sentence.`);
    expect(wholeTitle("A short title", "Other words.")).toBe("A short title");
    expect(wholeTitle("Cut…", "")).toBe("Cut");
  });
  test("an ask whose first line ends in ... opens its card (B1)", async () => {
    const s = setup();
    const a = s.f.addAsk({ agentId: "agent-w", prompt: "Two ways to fix the deploy...\nA or B?" });
    await s.src.poll();
    await s.e.settle();
    const c = cardOfAsk(s, a.id);
    expect(c.packet!.question).toBe("Two ways to fix the deploy...");
    expect([...s.e.log.all()].filter((e) => e.type === "policy.refused")).toEqual([]);
  });
  test("a page titled with its own ... opens its card; a cut board title takes the description's own ... whole", async () => {
    const s = setup();
    const p = s.f.raisePage({ title: "Deploy stuck..." });
    await s.src.poll();
    await s.e.settle();
    const c = [...s.e.cards.values()].find((x) => x.policy === "page" && x.subject === p.id)!;
    expect(c.packet!.question).toBe("Deploy stuck...");
    expect([...s.e.log.all()].filter((e) => e.type === "policy.refused")).toEqual([]);
    expect(wholeTitle(long.slice(0, 119) + "…", "The timer keeps running... It should stop.")).toBe("The timer keeps running... It should stop.");
  });
});

describe("inbox source", () => {
  test("an open ask becomes a decision card with the ask's packet; a secret request never comes in", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS, [{ name: "shot.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }]);
    s.f.addAsk({ agentId: "agent-w", prompt: "The API key, please", secret: { requestId: "x" } });
    const r = await s.src.poll();
    expect(r).toMatchObject({ asks: 1, secret: 1, opened: 1 });
    const c = cardOfAsk(s, a.id);
    expect(c.kind).toBe("decision");
    expect(c.meta).toMatchObject({ source: "Isomux Inbox", raw: "https://office.example.com/agents/agent-w", createdBy: "Demo Worker" });
    expect(c.packet!.question).toBe("Ship it now or behind a flag?");
    expect(c.packet!.blocks[0]).toEqual({ type: "markdown", text: "The flag costs a day." });
    expect(c.packet!.options!.map((o) => [o.id, o.label, o.fill])).toEqual([["a", "Ship now", { action: "reply", text: "Ship now" }], ["b", "Behind a flag", { action: "reply", text: "Behind a flag" }]]);
    expect(c.packet!.recommended).toBe("b");
    const img = c.packet!.blocks.find((b) => b.type === "image") as { blob: string; caption: string };
    expect(img.caption).toBe("shot.png");
    expect(s.blobs.get(img.blob, null).status).toBe(200);
    expect([...s.e.cards.values()].filter((x) => x.policy === "ask")).toHaveLength(1);
    // The second read emits nothing new, and neither does a restart (the state is the log).
    expect(await s.src.poll()).toMatchObject({ opened: 0, changed: 0, closed: 0 });
    const again = engine(s.dir, { projects: load(), predict: fakePredict({}).rt, clock: s.clock }).e;
    s.e.close();
    expect(await new InboxSource(again, s.office, s.blobs, "inbox", "inbox").poll()).toMatchObject({ opened: 0, changed: 0, closed: 0 });
  });

  test("commands show as code lines, edit files as one line, a file that does not load says so", () => {
    const p = packetOf({ prompt: "Run it?", agentId: "a", agentName: "A", roomName: "", createdAt: 0, updatedAt: 0, commands: ["bun run x"], editFiles: 2, files: [{ name: "gone.pdf", mediaType: "application/pdf", error: "the office has no such file" }] });
    expect(p.blocks.filter((b) => b.type === "code")).toEqual([{ type: "code", text: "bun run x" }]);
    expect(JSON.stringify(p.blocks)).toContain("opens 2 files in the editor");
    expect(JSON.stringify(p.blocks)).toContain("gone.pdf** did not load (the office has no such file)");
    expect(p.options).toBeUndefined();
  });

  test("with the asks refused the pages still come, the asks do not (the token is named), and the open ask cards stay", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const ca = cardOfAsk(s, a.id);
    s.f.switchOff = true;
    s.f.addAsk({ agentId: "agent-w", prompt: "Another?" });
    s.f.raisePage({ title: "Disk full" });
    const r = await s.src.poll();
    expect(r).toMatchObject({ asks: 0, pages: 1, opened: 1, closed: 0, asksOff: TOKEN_REFUSED });
    expect(s.e.cards.get(ca.id)!.state).not.toBe("withdrawn");
    expect([...s.e.cards.values()].map((c) => c.policy).sort()).toEqual(["ask", "page"]);
  });

  test("with no live owner agent the office refuses every read: the read says so and nothing opens or closes", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    s.f.noOwner = true;
    s.f.closeAsk(a.id);
    s.f.raisePage({ title: "Disk full" });
    await expect(s.src.poll()).rejects.toThrow(NO_OWNER);
    expect([...s.e.cards.values()].map((c) => [c.policy, c.state])).toEqual([["ask", "predicting"]]);
  });

  test("an ask or a page for another member never comes in (Nil would answer as himself)", async () => {
    const s = setup();
    s.f.addAsk({ ...OPTS, memberUserId: "someone-else" });
    const mine = s.f.addAsk({ agentId: "agent-w", prompt: "Mine?" });
    s.f.raisePage({ title: "Not yours", targetUserId: "someone-else" });
    s.f.raisePage({ title: "Yours" });
    expect(await s.src.poll()).toMatchObject({ asks: 1, pages: 1, other: 2, opened: 2 });
    expect([...s.e.cards.values()].map((c) => c.packet?.question ?? c.subject).sort()).toEqual(["Mine?", "Yours"]);
    expect(cardOfAsk(s, mine.id)).toBeTruthy();
  });

  test("an ask's link stays only as a path on the office", async () => {
    for (const bad of ["@evil.example/phish", "//evil.example/x", "https://evil.example", "/\\evil.example", "/a b", "agents/x", "", undefined]) expect(officePath(bad)).toBeNull();
    expect(officePath("/agents/agent-w")).toBe("/agents/agent-w");
    const s = setup();
    const bad = s.f.addAsk({ agentId: "agent-w", prompt: "Bad link?", link: "@evil.example/phish" });
    const good = s.f.addAsk({ agentId: "agent-w", prompt: "Good link?", link: "/agents/agent-w" });
    await s.src.poll();
    const links = (id: string) => cardOfAsk(s, id).packet!.blocks.filter((b) => b.type === "link");
    expect(links(bad.id)).toEqual([]);
    expect(links(good.id)).toEqual([{ type: "link", url: "https://office.example.com/agents/agent-w", label: "The office page this ask points to (/agents/agent-w)" }]);
    // The policy's own guard, for a link in an event that did not come through the source.
    const p = packetOf({ prompt: "Q?", agentId: "a", agentName: "A", roomName: "", createdAt: 0, updatedAt: 0, link: "@evil.example", editFiles: 0, files: [] });
    expect(p.blocks.filter((b) => b.type === "link")).toEqual([]);
  });

  test("a file over the cap is not read: its listed size says so first", async () => {
    const s = setup();
    const a = s.f.addAsk({ agentId: "agent-w", prompt: "Big?" }, [{ name: "big.bin", type: "application/octet-stream", bytes: new Uint8Array(8) }]);
    s.f.asks.get(a.id)!.readFiles![0].size = FILE_MAX + 1;
    let read = 0;
    const file = s.office.file.bind(s.office);
    s.office.file = (...x: Parameters<typeof file>) => (read++, file(...x));
    await s.src.poll();
    expect(read).toBe(0);
    expect(JSON.stringify(cardOfAsk(s, a.id).packet!.blocks)).toContain("big.bin** did not load (over the 20 MB that Antifeed keeps)");
  });

  test("an ask answered in the Inbox withdraws its card with the reason; an edited ask gets a new card", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    const b = s.f.addAsk({ agentId: "agent-w", prompt: "Which name?" });
    await s.src.poll();
    const ca = cardOfAsk(s, a.id);
    const cb = cardOfAsk(s, b.id);
    s.f.closeAsk(a.id);
    s.f.editAsk(b.id, { prompt: "Which name, A or B?" });
    expect(await s.src.poll()).toMatchObject({ closed: 1, changed: 1 });
    expect(s.e.cards.get(ca.id)!.state).toBe("withdrawn");
    expect(s.e.log.all().find((e) => e.type === "card.withdrawn" && e.card === ca.id)!.data).toEqual({ reason: CLOSED });
    expect(s.e.cards.get(cb.id)!.state).toBe("withdrawn");
    expect(s.e.log.all().find((e) => e.type === "card.withdrawn" && e.card === cb.id)!.data).toEqual({ reason: CHANGED });
    expect(cardOfAsk(s, b.id).packet!.question).toBe("Which name, A or B?");
  });
});

describe("ask calls", () => {
  test("a reply waits out the Undo time, goes to the office once, and then the Undo is refused", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Behind a flag" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Behind a flag" } });
    await s.d.tick();
    expect(s.f.answers).toHaveLength(0);
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    expect(s.f.answers).toEqual([{ ask: a.id, how: "reply", text: "Behind a flag", at: expect.any(Number) }]);
    expect(() => s.e.undo(MEMBER, c.id)).toThrow("Your answer went to the agent; it cannot be taken back.");
    // The office closed the ask: the next read closes it here too, and nothing comes back.
    await s.src.poll();
    expect(s.e.cards.get(c.id)!.state).toBe("decided");
    await s.d.tick();
    expect(s.f.answers).toHaveLength(1);
  });

  test("Undo inside the Undo time cancels the reply and puts the card back", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "dismiss", text: "" } });
    s.e.undo(MEMBER, c.id);
    expect(s.e.cards.get(c.id)!.state).toBe("open");
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    expect(s.f.answers).toHaveLength(0);
  });

  test("an ask closed in the office during the Undo time: not sent, with the reason; its Undo does not bring it back", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "file-task", text: "later" } });
    s.f.closeAsk(a.id);
    await s.src.poll();
    const k = [...s.e.commands.values()].find((x) => x.type === "inbox.file-task")!;
    expect(k).toMatchObject({ state: "cancelled", cancelReason: NOT_SENT_CLOSED });
    s.e.undo(MEMBER, c.id);
    expect(s.e.cards.get(c.id)!.state).toBe("withdrawn");
    expect(s.e.log.all().filter((e) => e.type === "card.withdrawn" && e.card === c.id).at(-1)!.data).toEqual({ reason: CLOSED });
  });

  test("the ask closes between the last read and the send: done with notSent, not a failure", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    s.f.closeAsk(a.id);
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    const k = [...s.e.commands.values()].find((x) => x.type === "inbox.reply")!;
    expect(k.state).toBe("done");
    expect(k.result).toEqual({ notSent: NOT_SENT_CLOSED });
    expect([...s.e.cards.values()].filter((x) => x.policy === "command-failed")).toHaveLength(0);
  });

  test("the outcome compares the action and the option the words came from, not the words", async () => {
    const s = setup();
    const p = packetOf({ prompt: "Q?", agentId: "a", agentName: "A", roomName: "", createdAt: 0, updatedAt: 0, options: ["Ship now", "Behind a flag"], editFiles: 0, files: [] });
    expect(choiceOf({ action: "reply", text: " Ship now " }, p)).toBe("Ship now");
    expect(choiceOf({ action: "reply", text: "ship it" }, p)).toBe("own words");
    expect(choiceOf({ action: "dismiss", text: "Ship now" }, p)).toBeNull();
    const a = s.f.addAsk({ agentId: "agent-w", prompt: "What should the error say?" });
    const b = s.f.addAsk(OPTS);
    await s.src.poll();
    // A free-text ask: the Premove's draft and Nil's own words are both "own words": edited, not changed.
    const ca = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Link expired." });
    s.e.decide(MEMBER, ca.id, { version: 1, call: { action: "reply", text: "This link has expired." } });
    expect(s.e.log.all().find((e) => e.type === "card.decided" && e.card === ca.id)!.data.outcome).toBe("edited");
    // Another option is a changed call.
    const cb = await premove(s, cardOfAsk(s, b.id).id, { action: "reply", text: "Behind a flag" });
    s.e.decide(MEMBER, cb.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    expect(s.e.log.all().find((e) => e.type === "card.decided" && e.card === cb.id)!.data.outcome).toBe("changed");
  });

  test("409 ask_busy: the answer is tried again, and goes out once when the other answer is done", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    s.f.busy.add(a.id);
    s.clock.t += CALL_HOLD_MS;
    setTimeout(() => s.f.busy.delete(a.id), 500);
    await s.d.tick();
    await s.e.settle();
    expect(s.f.answers.map((x) => x.text)).toEqual(["Ship now"]);
    expect([...s.e.commands.values()].find((x) => x.type === "inbox.reply")!.state).toBe("done");
  }, 10_000);

  test("an ask that stays busy: the answer fails, unsent, and says why", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    s.f.busy.add(a.id);
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    await s.e.settle();
    expect(s.f.answers).toEqual([]);
    const k = [...s.e.commands.values()].find((x) => x.type === "inbox.reply")!;
    expect(k.state).toBe("failed");
    expect(k.error).toContain("it was not sent");
  }, 10_000);

  test("the office app's Inbox has no consult: no predict goes out, and the quick model run makes each ask's Premove", async () => {
    expect(inbox.consult).toBeUndefined();
    const s = setup({ standin: async () => ({ call: { action: "reply", text: "Behind a flag" }, confidence: 0.6, why: "w", against: "a", by: "agent:standin@sonnet#s1" }) }, inbox);
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    await s.e.settle();
    expect([...s.e.commands.values()].filter((k) => k.type === "predict")).toEqual([]);
    s.e.checkPredicts();
    await s.e.settle();
    expect(cardOfAsk(s, a.id)).toMatchObject({ state: "open", prediction: { by: "agent:standin@sonnet#s1", standin: { reason: "this project has no consult agent" } } });
  });

  test("no Premove from the consult: the stand-in's call is whole (the pick's words, or the safe default), never empty", async () => {
    // The quick model run answers a reply with no words: refused, so the code stand-in fills in.
    const s = setup({ standin: async () => ({ call: { action: "reply" }, confidence: 0.6, why: "w", against: "a", by: "agent:standin@sonnet#s1" }) });
    const a = s.f.addAsk({ agentId: "agent-w", prompt: "Restart the backup?", options: ["Clear it and restart", "Only restart"], recommended: "Only restart" });
    const b = s.f.addAsk({ agentId: "agent-w", prompt: "What should the error say?" });
    await s.src.poll();
    await s.e.settle();
    // The office has no consult agent: the dispatcher cannot hand over the predicts.
    await s.d.tick();
    s.clock.t += 121_000;
    s.e.checkPredicts();
    await s.e.settle();
    expect(cardOfAsk(s, a.id).prediction).toMatchObject({ by: "code:standin", call: { action: "reply", text: "Only restart" }, standin: { basis: "author" } });
    expect(cardOfAsk(s, b.id).prediction).toMatchObject({ by: "code:standin", call: { action: "file-task", text: null }, standin: { basis: "none" } });
  });

  test("Part N: a reply when the office refuses Nil's token: a failure card that names the token, not a silent drop", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    s.f.nilRefused = true;
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    await s.e.settle();
    const k = [...s.e.commands.values()].find((x) => x.type === "inbox.reply")!;
    expect(k).toMatchObject({ state: "failed", blocked: true, error: TOKEN_REFUSED });
    const f = [...s.e.cards.values()].find((x) => x.policy === "command-failed")!;
    expect(f.packet!.question).toBe(`Your reply to Demo Worker did not go out: ${TOKEN_REFUSED}`);
    expect(f.packet!.question).toContain(NIL_TOKEN);
    expect(s.f.answers).toEqual([]);
  });

  test("a reply refused while Inbox access is off: a failure card in plain words, with no retry as its Premove", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: "Ship now" } });
    s.f.switchOff = true;
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    await s.e.settle();
    const k = [...s.e.commands.values()].find((x) => x.type === "inbox.reply")!;
    expect(k).toMatchObject({ state: "failed", blocked: true, error: ACCESS_OFF, about: { title: "Your reply to Demo Worker" } });
    const f = [...s.e.cards.values()].find((x) => x.policy === "command-failed")!;
    expect(f.packet!.question).toBe(`Your reply to Demo Worker did not go out: ${ACCESS_OFF}`);
    expect(f.packet!.blocks[0]).toEqual({ type: "fields", rows: [["Ask", "Ship it now or behind a flag?"], ["Agent", "Demo Worker"], ["Your words", "Ship now"]] });
    expect(JSON.stringify(f.packet!.blocks)).toContain('"title":"Ids, for a bug report"');
    await s.e.settle();
    expect(s.e.cards.get(f.id)!.prediction).toMatchObject({ call: { choice: "drop" } });
    // With no live owner agent, the card says that instead.
    const b = s.f.addAsk({ agentId: "agent-w", prompt: "Q2?" });
    s.f.switchOff = false;
    await s.src.poll();
    const c2 = await premove(s, cardOfAsk(s, b.id).id, { action: "dismiss", text: "" });
    s.e.decide(MEMBER, c2.id, { version: 1, call: { action: "dismiss", text: "" } });
    s.f.noOwner = true;
    s.clock.t += CALL_HOLD_MS;
    await s.d.tick();
    await s.e.settle();
    expect([...s.e.commands.values()].find((x) => x.type === "inbox.dismiss")!).toMatchObject({ state: "failed", blocked: true, error: OWNERLESS });
  });

  test("a reply needs words; asks never leave Nil", async () => {
    const s = setup();
    const a = s.f.addAsk(OPTS);
    await s.src.poll();
    const c = await premove(s, cardOfAsk(s, a.id).id, { action: "reply", text: "Ship now" });
    expect(() => s.e.decide(MEMBER, c.id, { version: 1, call: { action: "reply", text: null } })).toThrow("reply needs words");
    expect(() => s.e.setDecider(MEMBER, "ask", { kind: "threshold", agent: { kind: "consult", criteria: "ask-criteria.md" }, min: 0.9 })).toThrow();
  });
});

describe("pages", () => {
  test("a page is an action card; Done (after its Undo time) acks it; Could not do it does not", async () => {
    const s = setup();
    const p1 = s.f.raisePage({ title: "Disk 92% full", body: "Builds fail at 95%.", agentId: "agent-w", agentName: "Demo Worker", roomId: "r1" });
    const p2 = s.f.raisePage({ title: "Backup stuck" });
    await s.src.poll();
    const cards = [...s.e.cards.values()].filter((c) => c.policy === "page");
    expect(cards.map((c) => [c.kind, c.packet!.question])).toEqual([["action", "Disk 92% full"], ["action", "Backup stuck"]]);
    expect(cards[0].meta).toMatchObject({ source: "Isomux Inbox", createdBy: "Demo Worker", raw: "https://office.example.com/agents/agent-w", author: "code:inbox/page" });
    expect(JSON.stringify(cards[0].packet!.blocks)).toContain('["Room","Demo"]');
    s.e.completeAction(MEMBER, cards[0].id, { ok: true });
    s.e.completeAction(MEMBER, cards[1].id, { ok: false, note: "no access" });
    s.clock.t += 24_000;
    s.e.finishHeld();
    await s.d.tick();
    expect(s.f.acks).toEqual([p1.id]);
    expect(s.f.pages.get(p2.id)!.state).toBe("open");
  });

  test("a page acked in the Inbox, resolved or raised with new words withdraws its card with the reason", async () => {
    const s = setup();
    const a = s.f.raisePage({ title: "A" });
    const b = s.f.raisePage({ title: "B" });
    const c = s.f.raisePage({ title: "C", key: "k" });
    await s.src.poll();
    const card = (q: string) => [...s.e.cards.values()].find((x) => x.packet?.question === q)!;
    const [ca, cb, cc] = [card("A"), card("B"), card("C")];
    s.f.setPage(a.id, "acked");
    s.f.setPage(b.id, "resolved");
    s.f.raisePage({ title: "C again", key: "k" });
    await s.src.poll();
    const reason = (id: string) => s.e.log.all().filter((e) => e.type === "card.withdrawn" && e.card === id).at(-1)?.data.reason;
    expect([reason(ca.id), reason(cb.id), reason(cc.id)]).toEqual([PAGE_REASONS.acked, PAGE_REASONS.resolved, PAGE_CHANGED]);
    // A withdrawn action card takes its action with it.
    expect(s.e.commands.get(ca.command!)!.state).toBe("cancelled");
    expect(card("C again").state).toBe("open");
    void c;
  });

  test("a page raised again while Nil's Done waits: his Done acks it, and the new card says so", async () => {
    const s = setup();
    s.f.raisePage({ title: "A", key: "k" });
    await s.src.poll();
    const c1 = [...s.e.cards.values()].find((x) => x.policy === "page")!;
    s.e.completeAction(MEMBER, c1.id, { ok: true });
    s.f.raisePage({ title: "A again", key: "k" });
    await s.src.poll();
    const c2 = [...s.e.cards.values()].find((x) => x.packet?.question === "A again")!;
    s.clock.t += 24_000;
    s.e.finishHeld();
    await s.d.tick();
    await s.src.poll();
    expect(s.e.cards.get(c2.id)!.state).toBe("withdrawn");
    expect(s.e.log.all().filter((e) => e.type === "card.withdrawn" && e.card === c2.id).at(-1)!.data.reason).toBe(PAGE_ACKED_HERE);
  });

  test("a page raised again with the same words: the card shows the new count in place; a held card stays as it is", async () => {
    const s = setup();
    s.f.raisePage({ title: "A", key: "k" });
    await s.src.poll();
    const c = [...s.e.cards.values()].find((x) => x.policy === "page")!;
    s.f.raisePage({ title: "A", key: "k" });
    expect(await s.src.poll()).toMatchObject({ changed: 1, opened: 0 });
    expect(s.e.cards.get(c.id)).toMatchObject({ state: "open", version: 2 });
    expect(JSON.stringify(s.e.cards.get(c.id)!.packet!.blocks)).toContain('["Raised","2 times');
    expect([...s.e.cards.values()].filter((x) => x.policy === "page")).toHaveLength(1);
    s.e.completeAction(MEMBER, c.id, { ok: true });
    s.f.raisePage({ title: "A", key: "k" });
    await s.src.poll();
    expect(s.e.cards.get(c.id)!.version).toBe(2);
    expect([...s.e.cards.values()].filter((x) => x.policy === "page")).toHaveLength(1);
  });

  test("Could not do it on a page sends nothing and is not a failed command on Status", async () => {
    const s = setup();
    s.f.raisePage({ title: "A" });
    await s.src.poll();
    const c = [...s.e.cards.values()].find((x) => x.policy === "page")!;
    s.e.completeAction(MEMBER, c.id, { ok: false, note: "no access" });
    s.clock.t += 24_000;
    s.e.finishHeld();
    await s.d.tick();
    expect(s.f.acks).toEqual([]);
    expect(s.e.commands.get(c.command!)!.state).toBe("failed");
    expect([...s.e.cards.values()].filter((x) => x.policy === "command-failed")).toHaveLength(0);
  });

  test("a Done that waits for its Undo time is not withdrawn: it goes out and acks", async () => {
    const s = setup();
    const p = s.f.raisePage({ title: "A" });
    await s.src.poll();
    const c = [...s.e.cards.values()].find((x) => x.policy === "page")!;
    s.e.completeAction(MEMBER, c.id, { ok: true });
    s.f.setPage(p.id, "resolved");
    await s.src.poll();
    expect(s.e.cards.get(c.id)!.held).toBeTruthy();
    s.clock.t += 24_000;
    s.e.finishHeld();
    await s.d.tick();
    expect(s.e.cards.get(c.id)!.state).toBe("done");
    const ack = [...s.e.commands.values()].find((k) => k.type === "inbox.ack")!;
    expect(ack.result).toEqual({ notSent: "The page was already acked or resolved in the office." });
  });
});

describe("the fake office over HTTP", () => {
  test("the app's office client reads and answers it, and refuses with 403 before the reach", async () => {
    const f = new FakeInbox();
    const srv = Bun.serve({ port: 0, fetch: async (req) => (await f.handle(req, "/fake-office")) ?? new Response("no", { status: 404 }) });
    try {
      f.nilToken = "n1";
      const clock = { t: 0 };
      const o = httpOffice("t", `http://127.0.0.1:${srv.port}/fake-office`, SEND_MS, "n1", () => clock.t);
      const a = f.addAsk({ agentId: "ag", prompt: "Q?" }, [{ name: "n.txt", type: "text/plain", bytes: new TextEncoder().encode("hi") }]);
      const p = f.raisePage({ title: "P" });
      expect((await o.asks()).map((x) => x.id)).toEqual([a.id]);
      const got = await o.file("ag", a.readFiles![0].filename, FILE_MAX);
      expect(new TextDecoder().decode(got!.bytes)).toBe("hi");
      // Over the cap: the length header stops the read.
      await expect(o.file("ag", a.readFiles![0].filename, 1)).rejects.toThrow("that Antifeed keeps");
      expect(await o.answerAsk(a.id, "reply", "yes")).toBe("ok");
      expect(await o.answerAsk(a.id, "reply", "again")).toBe("gone");
      expect((await o.pages()).map((x) => x.id)).toEqual([p.id]);
      expect(await o.ackPage(p.id)).toBe("ok");
      expect((await o.page(p.id))!.state).toBe("acked");
      expect(await o.pages()).toEqual([]);
      f.busy.add(a.id);
      f.switchOff = true;
      await expect(o.asks()).rejects.toThrow(TOKEN_REFUSED);
      expect((await o.agents()).length).toBe(0);
      f.switchOff = false;
      clock.t += REFUSED_RETRY_MS;
      const b = f.addAsk({ agentId: "ag", prompt: "Q2?" });
      f.busy.add(b.id);
      expect(await o.answerAsk(b.id, "dismiss", "")).toBe("busy");
      // No live owner agent: Nil's token is refused there too, and the app token's read says 403.
      f.appToken = "t";
      f.noOwner = true;
      await expect(o.pages()).rejects.toThrow("GET /api/pager answered 403");
      await expect(o.agents()).rejects.toThrow("403");
    } finally {
      srv.stop(true);
    }
  });

  // Part N: Nil's API token (ANTIFEED_NIL_TOKEN) reads and answers his Inbox as him.
  test("Nil's token: his Inbox goes with it; without it the asks are not read and the pages go with the app token; a wrong one is refused in words that name it", async () => {
    const f = new FakeInbox();
    const seen: string[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (req) => {
      seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
      return (await f.handle(req, "/fake-office")) ?? new Response("no", { status: 404 });
    } });
    try {
      const url = `http://127.0.0.1:${srv.port}/fake-office`;
      const a = f.addAsk({ agentId: "ag", prompt: "Q?" });
      f.raisePage({ title: "P" });
      // No token: no asks read, no answer sent, the pages with the app token.
      const none = httpOffice("app", url);
      await expect(none.asks()).rejects.toThrow(NO_NIL_TOKEN);
      await expect(none.answerAsk(a.id, "reply", "yes")).rejects.toThrow(NO_NIL_TOKEN);
      expect((await none.pages()).length).toBe(1);
      expect(seen).toEqual(["/fake-office/api/pager Bearer app"]);
      // With it: every Inbox route as Nil.
      f.nilToken = "n1";
      seen.length = 0;
      const nil = httpOffice("app", url, SEND_MS, "n1");
      expect((await nil.asks()).map((x) => x.id)).toEqual([a.id]);
      expect((await nil.pages()).length).toBe(1);
      expect(await nil.answerAsk(a.id, "reply", "yes")).toBe("ok");
      expect(seen.every((x) => x.endsWith(" Bearer n1"))).toBe(true);
      // A wrong or revoked token: 401, in words that name the token. It is
      // not tried again for REFUSED_RETRY_MS (m2), and the pages go with the
      // app token meanwhile (m1).
      f.appToken = "app";
      const b = f.addAsk({ agentId: "ag", prompt: "Q2?" });
      const p2 = f.raisePage({ title: "P2" });
      const clock = { t: 0 };
      const bad = httpOffice("app", url, SEND_MS, "old", () => clock.t);
      seen.length = 0;
      expect((await bad.pages()).length).toBe(2);
      expect(seen).toEqual(["/fake-office/api/pager Bearer old", "/fake-office/api/pager Bearer app"]);
      for (const p of [() => bad.asks(), () => bad.answerAsk(b.id, "dismiss", ""), () => bad.file("ag", "f", 10)]) await expect(p()).rejects.toThrow(TOKEN_REFUSED);
      expect(await bad.ackPage(p2.id)).toBe("ok");
      expect(seen.filter((x) => x.endsWith("Bearer old")).length).toBe(1);
      clock.t += REFUSED_RETRY_MS;
      await expect(bad.asks()).rejects.toThrow(TOKEN_REFUSED);
      expect(seen.filter((x) => x.endsWith("Bearer old")).length).toBe(2);
      expect(TOKEN_REFUSED).toContain(NIL_TOKEN);
    } finally {
      srv.stop(true);
    }
  });
});
