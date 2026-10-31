// Part J: isomux sign-off (Nil's go, 2026-10-30). A fake Loop app stands for
// the live one: its Sign-off list, its images and its buttons. The source
// copies a waiting item's images into blobs and opens a card; the Scout's
// packet is checked (its pick, its verdict, plain words above the folds);
// its pick is the Premove; Nil's call presses the Loop app's button after the
// call's hold (comments first); Undo presses Undo while the Loop app takes it;
// a decision on the Loop app's own tab withdraws the card; a failed press is a
// failed-command card with the Loop app's words.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Blobs } from "../src/blobs";
import { CALL_HOLD_MS, Dispatcher } from "../src/dispatcher";
import { LoopSignoffSource } from "../src/loop-signoff";
import { checkProject, folderHash } from "../src/policies";
import { buildView } from "../src/view";
import isomux from "../projects/isomux/policies";
import signoffOnly from "../projects/isomux/signoff-walkthrough";
import { SIGNOFF_IN_ANTIFEED, signoffParts } from "../projects/isomux/signoff";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";

afterAll(cleanup);
// The sign-off parts with the switch on (the live file has it off until Nil's look).
const PATH = new URL("../projects/isomux/signoff-walkthrough.ts", import.meta.url).pathname;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// The fake Loop app: items by task id, and every press it got.
type Item = { taskId: string; title: string; summary: string; copy: { where: string; old: string; new: string; audience?: string }[]; images: { file: string; caption: string; type: string; pair?: string; side?: string }[]; merged: { commit: string; at: number } | null; state: string };
// It keeps each item's comments (across an Undo, as the Loop app does) and files the changes task from the stored ones.
const loop = { items: new Map<string, Item>(), comments: new Map<string, { copy: object; images: object }>(), filed: [] as string[], unpushed: [] as { taskId: string; commit: string; sent?: boolean }[], presses: [] as { path: string; body: string }[], fail: null as null | number, failBody: null as null | object, server: null as ReturnType<typeof Bun.serve> | null };
beforeAll(() => {
  loop.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/api/signoff") return Response.json({ items: [...loop.items.values()], unpushed: loop.unpushed });
      if (req.method === "GET" && u.pathname.startsWith("/img/signoff/")) return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      const m = u.pathname.match(/^\/api\/signoff\/([^/]+)\/(approve|reject|undo|comments)$/);
      if (req.method === "POST" && m) {
        const body = await req.text();
        loop.presses.push({ path: `${m[2]} ${m[1]}`, body });
        if (loop.fail && m[2] !== "comments") return Response.json(loop.failBody ?? { error: "only an item that waits for you can be approved" }, { status: loop.fail });
        const it = loop.items.get(m[1])!;
        if (m[2] === "comments") loop.comments.set(m[1], JSON.parse(body));
        if (m[2] === "approve") {
          const c = loop.comments.get(m[1]);
          const note = body ? String(JSON.parse(body).note ?? "") : "";
          if (note || (c && Object.keys(c.copy).length + Object.keys(c.images).length)) loop.filed.push(m[1]);
          it.state = "approved";
        }
        if (m[2] === "reject") {
          it.state = "rejected";
          return Response.json({ ok: true, revertIn: 60_000 });
        }
        if (m[2] === "undo") it.state = "waiting";
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.ANTIFEED_LOOP_URL = `http://127.0.0.1:${loop.server.port}`;
});
afterAll(() => {
  loop.server?.stop(true);
  delete process.env.ANTIFEED_LOOP_URL;
});

const item = (id: string, commit = "a".repeat(40), over: Partial<Item> = {}): Item => ({
  taskId: id, title: `[go | ready] Item ${id}`, summary: "The menu now opens on Asks.",
  copy: [{ where: "ui/src/Menu.tsx", old: "Pages", new: "Asks", audience: "member" }, { where: "skills/x/SKILL.md", old: "a", new: "b" }],
  images: [{ file: "1.png", caption: "Menu, before", type: "image/png", pair: "menu", side: "before" }, { file: "2.png", caption: "Menu, after", type: "image/png", pair: "menu", side: "after" }],
  merged: { commit, at: 1_793_000_000_000 }, state: "waiting", ...over,
});

function setup() {
  loop.items.clear();
  loop.comments.clear();
  loop.filed = [];
  loop.unpushed = [];
  loop.presses = [];
  loop.fail = null;
  loop.failBody = null;
  const dir = tempDir();
  const open = () => engine(dir, { projects: [{ def: signoffOnly, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
  const x = open();
  const blobs = new Blobs(dir);
  const source = new LoopSignoffSource(x.e, blobs, "isomux", "loop", process.env.ANTIFEED_LOOP_URL!);
  const office = new FakeOffice();
  office.roster.push({ id: "agent-scout-1", name: "Isomux Sign-off Scout" });
  const d = new Dispatcher(x.e, office, "http://127.0.0.1:1", () => x.clock.t);
  return { ...x, dir, open, blobs, source, d, office };
}
type S = ReturnType<typeof setup>;
const cardOf = (s: S, id: string) => [...s.e.cards.values()].filter((c) => c.policy === "signoff" && c.subject === id).at(-1)!;
const prepareOf = (s: S, id: string) => [...s.e.commands.values()].filter((k) => k.type === "signoff.prepare" && k.subject === id).at(-1)!;
const packet = (call: "approve" | "revert" = "approve", why = "Copy only, as you asked.", blobs: string[] = []) => ({
  question: "The menu opens on Asks",
  blocks: [
    { type: "markdown" as const, text: why },
    ...blobs.map((b, i) => ({ type: "image" as const, blob: b, caption: i ? "Menu, after" : "Menu, before", pair: { name: "menu", side: i ? ("after" as const) : ("before" as const) }, focus: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } })),
    { type: "fold" as const, title: "Commit", blocks: [{ type: "markdown" as const, text: "Changed ui/src/Menu.tsx in commit 1a2b3c4d" }] },
  ],
  options: [{ id: "pick", label: call === "approve" ? "Approve" : "Revert", fill: { call } }],
  recommended: "pick",
});
const meta = (verdict: "stamp" | "look" | "pushback" = "stamp", confidence = 0.8, commit = "a".repeat(40)) => ({ raw: "https://office.example.com/loop", commit, scout: { verdict, confidence, suggestions: { copy: { "0": "say Asks first" }, images: {} } } });
async function waiting(s: S, id: string, it = item(id), verdict: "stamp" | "look" | "pushback" = "stamp", call: "approve" | "revert" = "approve") {
  loop.items.set(id, it);
  await s.source.poll();
  const k = prepareOf(s, id);
  s.e.startCommand(k.id);
  s.e.postPacket({ command: k.id, packet: packet(call, call === "revert" ? "The menu lost its footer link." : "Copy only, as you asked.", (k.params as { images: { blob: string }[] }).images.map((m) => m.blob)), meta: meta(verdict, 0.8, (k.params as { commit: string }).commit) });
  await s.e.settle();
  return cardOf(s, id);
}
// The call's hold, then the press.
async function release(s: S) {
  await s.d.tick();
  s.clock.t += CALL_HOLD_MS + 1;
  await s.d.tick();
}

describe("isomux sign-off", () => {
  test("the policies files pass the load check; the switch off makes no sign-off parts", () => {
    expect(checkProject(signoffOnly)).toEqual([]);
    expect(checkProject(isomux)).toEqual([]);
    expect(isomux.policies.some((p) => p.id === "signoff")).toBe(SIGNOFF_IN_ANTIFEED);
    const off = signoffParts(false);
    expect([off.policies, off.sources, off.actors]).toEqual([[], [], []]);
    // With the switch on, isomux itself holds the sign-off parts (checked above).
    if (!SIGNOFF_IN_ANTIFEED) expect(checkProject({ ...isomux, ...{ actors: [...isomux.actors, ...signoffParts(true).actors], sources: [...(isomux.sources ?? []), ...signoffParts(true).sources], events: { ...isomux.events, ...signoffParts(true).events }, policies: [...isomux.policies.filter((p) => p.id !== "signoff"), ...signoffParts(true).policies], handlers: signoffParts(true).handlers, run: signoffParts(true).run } })).toEqual([]);
  });

  test("a waiting item: its images copied into blobs, one card, the Scout's prepare; its pick is the Premove with its confidence; the view has the item", async () => {
    const s = setup();
    loop.items.set("t1", item("t1"));
    loop.items.set("t2", item("t2", "b".repeat(40), { state: "approved" }));
    const r = await s.source.poll();
    expect(r).toMatchObject({ waiting: 1, left: 0 });
    // A second read with nothing new emits nothing.
    expect(await s.source.poll()).toMatchObject({ waiting: 0, left: 0 });
    const k = prepareOf(s, "t1");
    const images = (k.params as { images: { blob: string; caption: string; pair?: string; side?: string }[] }).images;
    expect(k.params).toMatchObject({ taskId: "t1", commit: "a".repeat(40) });
    expect(images.map((m) => [m.caption, m.pair, m.side])).toEqual([["Menu, before", "menu", "before"], ["Menu, after", "menu", "after"]]);
    expect(s.blobs.path(images[0].blob)).not.toBeNull();
    expect(k.actor).toBe("scout");
    s.e.startCommand(k.id);
    s.e.postPacket({ command: k.id, packet: packet("approve", "Copy only, as you asked.", images.map((m) => m.blob)), meta: meta("look", 0.7) });
    await s.e.settle();
    const c = cardOf(s, "t1");
    expect(c.state).toBe("open");
    expect(c.prediction).toMatchObject({ call: { call: "approve" }, confidence: 0.7, by: "code:authorPick" });
    const v = buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" });
    const vc = v.cards.find((x) => x.id === c.id) as any;
    expect(vc.subjectInfo.signoff).toMatchObject({ taskId: "t1", commit: "a".repeat(40), summary: "The menu now opens on Asks.", loopState: "waiting" });
    expect(vc.subjectInfo.signoff.copy.map((x: { audience: string }) => x.audience)).toEqual(["member", "member"]);
    expect(v.policies.find((p: any) => p.id === "signoff")!.cardKind).toBe("loop");
  });

  test("the Scout's packet: one pick, a why of at most 15 words, a verdict and a confidence; plain words above the folds, the question too; the folds may hold paths", async () => {
    const s = setup();
    loop.items.set("t1", item("t1"));
    await s.source.poll();
    const k = prepareOf(s, "t1");
    s.e.startCommand(k.id);
    const post = (p: object, m: object = meta()) => s.e.postPacket({ command: k.id, packet: { ...packet(), ...p } as any, meta: m as any });
    expect(() => post({}, { raw: "x", scout: meta().scout })).toThrow(/meta.commit is the merge you read/);
    expect(() => post({}, { raw: "x", commit: "a".repeat(40) })).toThrow(/meta.scout.verdict/);
    expect(() => post({}, { raw: "x", commit: "a".repeat(40), scout: { verdict: "stamp", confidence: 2 } })).toThrow(/confidence is a number from 0 to 1/);
    expect(() => post({ options: [{ id: "pick", label: "Reject", fill: { call: "reject" } }] })).toThrow(/"call":"approve"/);
    expect(() => post({ blocks: [{ type: "markdown", text: Array(16).fill("w").join(" ") }] })).toThrow(/the why is 16 words; the cap is 15/);
    expect(() => post({ blocks: [{ type: "markdown", text: "It changes Menu.tsx only." }] })).toThrow(/"Menu.tsx" is a file name/);
    expect(() => post({ question: "Menu: ui/src/Menu.tsx opens on Asks" })).toThrow(/packet.question: "ui\/src\/Menu.tsx" is a file path/);
    // The Commit fold names a path and a hash: it passes.
    post({});
    expect(cardOf(s, "t1").version).toBe(1);
  });

  test("Approve with no note or comments presses the plain approve after the call's hold; Undo presses Undo; the item waits again on the same card", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    expect(cardOf(s, "t1").decision).toBeTruthy();
    await s.d.tick();
    expect(loop.presses).toEqual([]);
    s.clock.t += CALL_HOLD_MS + 1;
    await s.d.tick();
    const NONE = JSON.stringify({ copy: {}, images: {} });
    expect(loop.presses).toEqual([{ path: "comments t1", body: NONE }, { path: "approve t1", body: "" }]);
    const apply = [...s.e.commands.values()].find((k) => k.type === "signoff.apply")!;
    expect(apply.state).toBe("done");
    // The source sees it approved: the card stays decided, no withdraw.
    expect(await s.source.poll()).toMatchObject({ left: 1 });
    expect(cardOf(s, "t1").state).toBe("decided");
    s.e.undo(MEMBER, c.id);
    await s.d.tick();
    expect(loop.presses.at(-1)).toEqual({ path: "undo t1", body: "" });
    expect(cardOf(s, "t1").id).toBe(c.id);
    expect(cardOf(s, "t1").state).toBe("open");
    // The item waits again: the same card, open, with no new prepare.
    const prepares = [...s.e.commands.values()].filter((k) => k.type === "signoff.prepare").length;
    expect(await s.source.poll()).toMatchObject({ waiting: 1 });
    expect([...s.e.commands.values()].filter((k) => k.type === "signoff.prepare").length).toBe(prepares);
    expect(cardOf(s, "t1")).toMatchObject({ id: c.id, state: "open" });
    s.e.close();
    expect(s.open().e.replayDiffs).toEqual([]);
  });

  test("Approve with a note and comments sends the comments first, then approve with the note; Undo inside the hold cancels and presses nothing", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    const comments = JSON.stringify({ copy: { "0": "say Asks first", "1": " " }, images: { "1": "the box is too small" } });
    expect(() => s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve", comments: "{bad" } })).toThrow(/comments must be JSON/);
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve", note: "Use the word Asks.", comments } });
    await release(s);
    expect(loop.presses).toEqual([
      { path: "comments t1", body: JSON.stringify({ copy: { "0": "say Asks first" }, images: { "1": "the box is too small" } }) },
      { path: "approve t1", body: JSON.stringify({ note: "Use the word Asks." }) },
    ]);
    expect([...s.e.commands.values()].find((k) => k.type === "signoff.apply")!.result).toMatchObject({ sent: "approve", filesTask: true });
    // Another item: Undo inside Antifeed's hold cancels the press.
    const c2 = await waiting(s, "t2");
    s.e.decide(MEMBER, c2.id, { version: 1, call: { call: "approve" } });
    await s.d.tick();
    s.e.undo(MEMBER, c2.id);
    await release(s);
    expect(loop.presses.filter((p) => p.path.endsWith("t2"))).toEqual([]);
    expect([...s.e.commands.values()].find((k) => k.type === "signoff.apply" && k.subject === "t2")!.state).toBe("cancelled");
  });

  test("Revert needs a note and presses reject with it; Undo goes until 55 s after the press, then it is refused with the Loop app's reason", async () => {
    const s = setup();
    const c = await waiting(s, "t1", item("t1"), "pushback", "revert");
    expect(c.prediction).toMatchObject({ call: { call: "revert", note: "The menu lost its footer link." } });
    expect(() => s.e.decide(MEMBER, c.id, { version: 1, call: { call: "revert" } })).toThrow(/Revert needs a note/);
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "revert", note: "The footer link is gone." } });
    await release(s);
    expect(loop.presses).toEqual([{ path: "comments t1", body: JSON.stringify({ copy: {}, images: {} }) }, { path: "reject t1", body: JSON.stringify({ note: "The footer link is gone." }) }]);
    s.clock.t += 30_000;
    s.e.undo(MEMBER, c.id);
    await s.d.tick();
    expect(loop.presses.at(-1)!.path).toBe("undo t1");
    // A second revert, and an Undo past the Loop app's hold.
    await s.source.poll();
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "revert", note: "Still gone." } });
    await release(s);
    // Reviewer m2: refused 20 s before the Loop app sends it (its revertIn, from the press).
    s.clock.t += 39_000;
    expect(() => s.e.undo(MEMBER, c.id)).not.toThrow();
    await s.d.tick();
    await s.source.poll();
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "revert", note: "Gone again." } });
    await release(s);
    s.clock.t += 41_000;
    expect(() => s.e.undo(MEMBER, c.id)).toThrow(/Isomux Main has the revert request already/);
  });

  test("decided on the Loop app's tab: an open card is withdrawn with the reason; a call not sent yet is cancelled (F1); a re-merge is the card's next version", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.items.get("t1")!.state = "approved";
    await s.source.poll();
    expect(cardOf(s, "t1").state).toBe("withdrawn");
    expect(s.e.log.all().find((x) => x.type === "card.withdrawn" && x.card === c.id)!.data.reason).toBe("You decided it on the Loop app's tab (approved).");
    // F1: Nil's call waits out its hold, and the item is decided there first.
    const c2 = await waiting(s, "t2");
    s.e.decide(MEMBER, c2.id, { version: 1, call: { call: "approve" } });
    await s.d.tick();
    loop.items.get("t2")!.state = "rejected";
    await s.source.poll();
    await release(s);
    expect(loop.presses).toEqual([]);
    const k = [...s.e.commands.values()].find((x) => x.type === "signoff.apply" && x.subject === "t2")!;
    expect(k.state).toBe("cancelled");
    // A re-merge while the card is open: the Scout writes its next version.
    const c3 = await waiting(s, "t3");
    loop.items.set("t3", item("t3", "c".repeat(40)));
    await s.source.poll();
    const again = prepareOf(s, "t3");
    expect(again.card).toBe(c3.id);
    expect(again.params).toMatchObject({ commit: "c".repeat(40), revise: "the item was merged again: a new commit" });
  });

  test("the Loop app refuses (4xx): a failed-command card with its words; no answer: may have gone", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.fail = 400;
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    await release(s);
    const k = [...s.e.commands.values()].find((x) => x.type === "signoff.apply")!;
    expect(k.state).toBe("failed");
    expect(k.error).toBe("the Loop app refused it: only an item that waits for you can be approved");
    await s.e.settle();
    const fc = [...s.e.cards.values()].find((x) => x.policy === "command-failed")!;
    expect(fc).toBeTruthy();
    // A 5xx: may have gone, with no retry as its Premove.
    loop.fail = 502;
    const c2 = await waiting(s, "t2");
    s.e.decide(MEMBER, c2.id, { version: 1, call: { call: "approve" } });
    await release(s);
    const k2 = [...s.e.commands.values()].find((x) => x.type === "signoff.apply" && x.subject === "t2")!;
    expect(k2.state).toBe("failed");
    expect(s.e.log.all().find((x) => x.type === "command.failed" && x.command === k2.id)!.data).toMatchObject({ maybeSent: true, detail: "POST /api/signoff/t2/approve answered 502" });
  });
  // Reviewer B1: the Loop app keeps comments across an Undo; Nil's next plain approve clears them, so no changes task.
  test("every call replaces the Loop app's stored comments: a plain approve after an Undo of an approve with comments files no changes task", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve", comments: JSON.stringify({ copy: { "0": "say Asks first" }, images: {} }) } });
    await release(s);
    expect(loop.filed).toEqual(["t1"]);
    s.e.undo(MEMBER, c.id);
    await s.d.tick();
    await s.source.poll();
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    await release(s);
    expect(loop.filed).toEqual(["t1"]);
    expect(loop.comments.get("t1")).toEqual({ copy: {}, images: {} });
  });

  // Reviewer B2: Nil's call goes to the merge his packet showed.
  test("a re-merge before the Scout's new packet: Nil's call on the old packet is not sent, nothing pressed", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.items.set("t1", item("t1", "c".repeat(40)));
    await s.source.poll();
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    await release(s);
    expect(loop.presses).toEqual([]);
    const k = [...s.e.commands.values()].find((x) => x.type === "signoff.apply")!;
    expect(k.params).toMatchObject({ commit: "a".repeat(40) });
    expect(k.result).toEqual({ notSent: "the item is at a new merge on the Loop app now" });
    // The item still waits at its new merge: a new card shows it.
    const next = cardOf(s, "t1");
    expect(next.id).not.toBe(c.id);
    expect(prepareOf(s, "t1").params).toMatchObject({ commit: "c".repeat(40) });
    // An Undo of the call that did not go: the old card leaves, the new one stays.
    s.e.undo(MEMBER, c.id);
    expect(s.e.cards.get(c.id)!.state).toBe("withdrawn");
    expect([...s.e.cards.values()].filter((x) => x.subject === "t1" && x.state !== "withdrawn")).toHaveLength(1);
  });

  // Reviewer m1 and m3.
  test("a 502 that says the item is not approved is a plain failure; a push go ends an approval's Undo", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.fail = 502;
    loop.failBody = { error: "the board refused the Sign-off changes task (502); the item is not approved yet" };
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve", note: "Use Asks." } });
    await release(s);
    const k = [...s.e.commands.values()].find((x) => x.type === "signoff.apply")!;
    expect(s.e.log.all().find((x) => x.type === "command.failed" && x.command === k.id)!.data).toMatchObject({ error: "the Loop app did not approve it: the board refused the Sign-off changes task (502); the item is not approved yet" });
    expect(s.e.log.all().find((x) => x.type === "command.failed" && x.command === k.id)!.data.maybeSent).toBeUndefined();
    loop.fail = null;
    const c2 = await waiting(s, "t2");
    s.e.decide(MEMBER, c2.id, { version: 1, call: { call: "approve" } });
    await release(s);
    await s.source.poll();
    loop.unpushed = [{ taskId: "t2", commit: "a".repeat(40) }];
    await s.source.poll();
    expect(s.e.log.all().filter((x) => x.type === "signoff.item.pushgo")).toHaveLength(0);
    loop.unpushed = [{ taskId: "t2", commit: "a".repeat(40), sent: true }];
    await s.source.poll();
    expect(s.e.log.all().filter((x) => x.type === "signoff.item.pushgo" && x.subject === "t2")).toHaveLength(1);
    await s.source.poll();
    expect(s.e.log.all().filter((x) => x.type === "signoff.item.pushgo")).toHaveLength(1);
    expect(() => s.e.undo(MEMBER, c2.id)).toThrow(/A push go took this approval already/);
    s.e.close();
    expect(s.open().e.replayDiffs).toEqual([]);
  });
  // Reviewer B3: an approved item stays listed after the push; it leaves unpushed with no sent window seen.
  test("an approved item that leaves the unpushed list (pushed, no push-go window seen): its Undo is refused, nothing pressed; a short sha in meta.commit is the same merge", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.unpushed = [{ taskId: "t1", commit: "a".repeat(40) }];
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    await release(s);
    await s.source.poll();
    expect(s.e.log.all().filter((x) => x.type === "signoff.item.pushgo")).toHaveLength(0);
    loop.unpushed = [];
    await s.source.poll();
    const n = loop.presses.length;
    expect(() => s.e.undo(MEMBER, c.id)).toThrow(/A push go took this approval already/);
    await s.d.tick();
    expect(loop.presses.length).toBe(n);
    // m4: the Scout gives a short sha; Nil's call goes.
    loop.items.set("t5", item("t5"));
    await s.source.poll();
    const k = prepareOf(s, "t5");
    s.e.startCommand(k.id);
    expect(() => s.e.postPacket({ command: k.id, packet: packet(), meta: meta("stamp", 0.8, "a1b2") })).toThrow(/7 to 40 hex digits/);
    s.e.postPacket({ command: k.id, packet: packet(), meta: meta("stamp", 0.8, "a".repeat(10)) });
    await s.e.settle();
    s.e.decide(MEMBER, cardOf(s, "t5").id, { version: 1, call: { call: "approve" } });
    await release(s);
    expect(loop.presses.at(-1)).toEqual({ path: "approve t5", body: "" });
  });

  // B4 (Antifeed Reviewer, 2026-10-30): the switch off keeps the log; the cards and commands of the policy are off, not gone.
  test("switch on, then off: no sign-off card in the view or the queue, a call or Undo is 409, its commands are not sent or counted; on again, all of it is back", async () => {
    const s = setup();
    const c = await waiting(s, "t1");
    loop.items.set("t2", item("t2", "b".repeat(40)));
    await s.source.poll();
    s.e.decide(MEMBER, c.id, { version: 1, call: { call: "approve" } });
    const k2 = prepareOf(s, "t2").id;
    s.e.close();
    const LIVE = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
    // The live isomux project with the switch off: no sign-off policy.
    const offDef = { ...isomux, policies: isomux.policies.filter((p) => p.id !== "signoff") };
    const off = engine(s.dir, { clock: s.clock, projects: [{ def: offDef, path: LIVE, hash: folderHash(LIVE) }], predict: fakePredict().rt }).e;
    expect(off.replayDiffs).toEqual([]);
    expect(off.isOn("signoff")).toBe(false);
    const ids = [c.id, cardOf({ e: off } as S, "t2").id];
    const v = JSON.stringify(buildView({ engine: off, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }));
    for (const id of ids) expect(v).not.toContain(id);
    expect(off.queue().filter((x) => x.policy === "signoff")).toEqual([]);
    expect(() => off.decide(MEMBER, ids[1], { version: 1, call: { call: "approve" } })).toThrow(/this policy is off/);
    expect(() => off.undo(MEMBER, c.id)).toThrow(/this policy is off/);
    expect(() => off.startCommand(k2)).toThrow(/this policy is off/);
    const ks = [...off.commands.values()].filter((k) => k.policy === "signoff" && !["done", "cancelled"].includes(k.state));
    expect(ks.length).toBeGreaterThan(1);
    expect(ks.filter((k) => off.commandOn(k))).toEqual([]);
    // Nothing goes out while it is off, the call's hold ended or not.
    const office = new FakeOffice();
    office.roster.push({ id: "agent-scout-1", name: "Isomux Sign-off Scout" });
    const d = new Dispatcher(off, office, "http://127.0.0.1:1", () => s.clock.t);
    loop.presses = [];
    s.clock.t += CALL_HOLD_MS + 1;
    await d.tick();
    off.fireWakes();
    expect(office.sent).toEqual([]);
    expect(loop.presses).toEqual([]);
    off.close();
    // On again: the cards and the commands are back, and the call goes out.
    const on = s.open().e;
    expect(on.replayDiffs).toEqual([]);
    const v2 = JSON.stringify(buildView({ engine: on, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }));
    for (const id of ids) expect(v2).toContain(id);
    expect(on.cards.get(c.id)!.state).toBe("decided");
    expect(on.commands.get(k2)!.state).toBe("issued");
    const d2 = new Dispatcher(on, s.office, "http://127.0.0.1:1", () => s.clock.t);
    await d2.tick();
    expect(loop.presses.map((x) => x.path)).toEqual(["comments t1", "approve t1"]);
    expect(s.office.sent.some((m) => m.text.includes(k2))).toBe(true);
  });
});
