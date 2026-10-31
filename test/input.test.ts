// Round q1, I: Nil's input that becomes a task. One task per clientId, on the
// target's board, untagged, its description naming Nil first; then the
// target's PM is told. Each write goes once; a failure shows with its next
// step; the target and the PM come from the app's list, never the body; no
// policy hears input.*; replay is clean.
import { afterAll, describe, expect, test } from "bun:test";
import { INPUT_MAX } from "../src/engine";
import { INPUT_TARGETS, InputSender, inputTitle } from "../src/input";
import { nullOffice } from "../src/office";
import { folderHash } from "../src/policies";
import { buildView } from "../src/view";
import isomux from "../projects/isomux/policies";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";

afterAll(cleanup);

const ISO = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const projects = [{ def: isomux, path: ISO, hash: folderHash(ISO) }];
const ids = INPUT_TARGETS.map((t) => t.id);
const iso = INPUT_TARGETS.find((t) => t.id === "isomux")!;

function setup(dir = tempDir(), fp = fakePredict()) {
  const x = engine(dir, { projects, predict: fp.rt, inputTargets: ids });
  const office = new FakeOffice();
  office.roster.push({ id: iso.pm.id, name: iso.pm.name });
  return { ...x, dir, fp, office, input: new InputSender(x.e, office) };
}
type S = ReturnType<typeof setup>;
let n = 0;
const cid = () => `client${String(n++).padStart(4, "0")}`;
async function send(s: S, text = "The filter row wraps on the phone", target = "isomux", extra: object = {}) {
  const r = s.e.inputSend(MEMBER, { text, target, page: "queue", clientId: cid(), ...extra });
  await s.input.send(r.event.id);
  return s.e.inputs.get(r.event.id)!;
}

describe("Nil's input that becomes a task", () => {
  test("it files an untagged task on the target's board, Nil named first, then tells the target's PM by id", async () => {
    const s = setup();
    const r = await send(s, "The filter row wraps on the phone\nIt pushes the first card down.");
    expect(s.office.filed).toEqual([{ title: "The filter row wraps on the phone", description: "Filed by Antifeed for Nil on its Queue page. His words:\n\nThe filter row wraps on the phone\nIt pushes the first card down.", roomId: "e6818e47" }]);
    expect(s.office.sent).toEqual([{ to: iso.pm.id, text: 'Nil filed task task1 in your room through Antifeed: "The filter row wraps on the phone". The task holds his words.' }]);
    expect(r).toMatchObject({ state: "told", taskId: "task1", target: "isomux" });
  });

  test("the same clientId files once; a bad target, text or card is a 400 and files nothing", async () => {
    const s = setup();
    const a = s.e.inputSend(MEMBER, { text: "x", target: "isomux", page: "queue", clientId: "same-client-1" });
    const b = s.e.inputSend(MEMBER, { text: "x", target: "isomux", page: "queue", clientId: "same-client-1" });
    expect(b).toMatchObject({ duplicate: true, event: { id: a.event.id } });
    expect(s.e.inputs.size).toBe(1);
    expect(() => s.e.inputSend(MEMBER, { text: "x", target: "elsewhere", clientId: cid() })).toThrow(/pick where it goes/);
    expect(() => s.e.inputSend(MEMBER, { text: "  ", target: "isomux", clientId: cid() })).toThrow(/write something first/);
    expect(() => s.e.inputSend(MEMBER, { text: "x".repeat(INPUT_MAX + 1), target: "isomux", clientId: cid() })).toThrow(/at most/);
    expect(() => s.e.inputSend(MEMBER, { text: "x", target: "isomux", card: "c_none", clientId: cid() })).toThrow(/unknown packet/);
    expect(() => s.e.inputSend("", { text: "x", target: "isomux", clientId: cid() })).toThrow(/member id/);
    expect(s.office.filed).toEqual([]);
  });

  test("refused, no clear answer, no office token: each shows, and nothing is sent again on its own", async () => {
    const s = setup();
    s.office.failTasks.push("POST /api/tasks answered 422", "POST /api/tasks answered 502");
    expect(await send(s)).toMatchObject({ state: "failed", error: "the office refused it", detail: "POST /api/tasks answered 422" });
    expect(await send(s)).toMatchObject({ state: "maybe", error: "the office gave no clear answer", detail: "POST /api/tasks answered 502" });
    const r = s.e.inputSend(MEMBER, { text: "x", target: "isomux", clientId: cid() });
    await new InputSender(s.e, nullOffice).send(r.event.id);
    expect(s.e.inputs.get(r.event.id)).toMatchObject({ state: "failed", error: "this copy of the app has no office token, so nothing was filed" });
    expect(s.office.filed).toEqual([]);
    expect(s.office.sent).toEqual([]);
  });

  test("filed but the PM not told: Tell again sends only the message", async () => {
    const s = setup();
    s.office.failSends = 1;
    const r = await send(s);
    expect(r).toMatchObject({ state: "untold", taskId: "task1", error: "the office gave no clear answer", detail: "POST /api/app/message answered 502" });
    s.e.inputTell(MEMBER, r.id);
    await s.input.tell(r.id);
    expect(s.e.inputs.get(r.id)).toMatchObject({ state: "told", taskId: "task1" });
    expect(s.office.filed.length).toBe(1);
    expect(s.office.sent.length).toBe(1);
    expect(() => s.e.inputTell(MEMBER, r.id)).toThrow(/told already/);
  });

  test("an input cut by a restart: before its task it may have been filed; after it the PM was not told", async () => {
    const s = setup();
    const a = s.e.inputSend(MEMBER, { text: "cut before", target: "isomux", clientId: cid() }).event.id;
    const b = s.e.inputSend(MEMBER, { text: "cut after", target: "wallgame", clientId: cid() }).event.id;
    s.e.inputOutcome(b, { filed: "taskB" });
    s.e.close();
    const again = engine(s.dir, { projects, predict: s.fp.rt });
    expect(again.e.inputRestarted()).toBe(2);
    expect(again.e.inputs.get(a)).toMatchObject({ state: "maybe", error: "the app restarted while it filed this" });
    expect(again.e.inputs.get(b)).toMatchObject({ state: "untold", taskId: "taskB", error: "the app restarted before it told the PM" });
    expect(again.e.inputRestarted()).toBe(0);
    again.e.close();
  });

  test("input.* changes no card and no policy state; a long input is in a blob; replay gives no difference", async () => {
    const s = setup();
    const before = JSON.stringify([...s.e.cards.values()]);
    const r = await send(s, "y".repeat(3_000));
    expect(r.blob).toBeDefined();
    expect(JSON.stringify([...s.e.cards.values()])).toBe(before);
    s.e.close();
    const again = engine(s.dir, { projects, predict: s.fp.rt });
    expect(again.e.replayDiffs).toEqual([]);
    expect(again.e.inputText(again.e.inputs.get(r.id)!)).toHaveLength(3_000);
    again.e.close();
  });

  test("the view lists the targets and the last inputs, newest first; the whole text only of one to send again", async () => {
    const s = setup();
    await send(s, "first");
    await send(s, "second", "antifeed");
    const v = buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }) as any;
    expect(v.inputs.targets.map((t: any) => t.id)).toEqual(["antifeed", "isomux", "wallgame"]);
    expect(v.inputs.sent.map((x: any) => x.title)).toEqual(["second", "first"]);
    expect(v.inputs.sent[1]).toMatchObject({ target: "isomux", state: "told", taskId: "task1" });
    expect(v.inputs.sent[1].text).toBeUndefined();
    s.office.failTasks.push("POST /api/tasks answered 422");
    await send(s, "third\nwith more");
    const w = buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }) as any;
    expect(w.inputs.sent[0]).toMatchObject({ state: "failed", title: "third", text: "third\nwith more" });
  });

  test("a title is the whole first line, never cut (Nil, 2026-10-30)", () => {
    expect(inputTitle("  one line \nmore")).toBe("one line");
    expect(inputTitle("word ".repeat(40))).toBe("word ".repeat(40).trim());
  });

  test("the HTTP routes need the member header; a duplicate files once", async () => {
    const { makeApi, MEMBER_HEADER } = await import("../src/api");
    const { Blobs } = await import("../src/blobs");
    const s = setup();
    const api = makeApi({ engine: s.e, blobs: new Blobs(s.dir), member: MEMBER, base: "http://x", input: (id, tell) => (tell ? s.input.tell(id) : s.input.send(id)) });
    const post = (path: string, b: object, member = true) => api(new Request("http://x" + path, { method: "POST", headers: { "Content-Type": "application/json", ...(member ? { [MEMBER_HEADER]: MEMBER } : {}) }, body: JSON.stringify(b) }));
    const b = { text: "hi", target: "isomux", page: "queue", clientId: "route-client-1" };
    expect((await post("/api/inputs", b, false)).status).toBe(403);
    expect((await post("/api/inputs", b)).status).toBe(200);
    expect(await (await post("/api/inputs", b)).json()).toMatchObject({ duplicate: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.office.filed.length).toBe(1);
  });

  // Part K (Nil, 2026-10-30: "i can't attach screenshots to new tasks").
  test("screenshots: stored as blobs, one server path per image at the end of the task, the PM told the count; at most 4, 8 MB each; a duplicate files once with the same images", async () => {
    const { makeApi, MEMBER_HEADER } = await import("../src/api");
    const { Blobs } = await import("../src/blobs");
    const s = setup();
    const blobs = new Blobs(s.dir);
    const input = new InputSender(s.e, s.office, (n) => blobs.path(n));
    const api = makeApi({ engine: s.e, blobs, member: MEMBER, base: "http://x", input: (id, tell) => (tell ? input.tell(id) : input.send(id)) });
    const post = (path: string, b: object) => api(new Request("http://x" + path, { method: "POST", headers: { "Content-Type": "application/json", [MEMBER_HEADER]: MEMBER }, body: JSON.stringify(b) }));
    const png = (n: number) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47]); b[n - 1] = n % 251; return b; };
    const put = async (bytes: Uint8Array) => (await (await api(new Request("http://x/api/blobs", { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes as unknown as BodyInit }))).json()).blob as string;
    const a = await put(png(1000));
    const c = await put(png(2000));
    const big = await put(png(9 * 2 ** 20));
    const b = { text: "The menu covers the footer", target: "isomux", page: "queue", clientId: "shots-client-1", images: [a, c] };
    expect((await post("/api/inputs", b)).status).toBe(200);
    expect(await (await post("/api/inputs", { ...b, images: [] })).json()).toMatchObject({ duplicate: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.office.filed).toHaveLength(1);
    expect(s.office.filed[0].description).toBe(`Filed by Antifeed for Nil on its Queue page. His words:\n\nThe menu covers the footer\n\nScreenshot: ${blobs.path(a)}\nScreenshot: ${blobs.path(c)}`);
    expect(blobs.path(a)!.startsWith("/")).toBe(true);
    expect(s.office.sent[0].text).toContain("The task holds his words and 2 screenshots (their server paths at the end).");
    const v = buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" });
    expect(v.inputs.sent[0]).toMatchObject({ images: [a, c] });
    // A 9 MB file, five images, a name that is not a stored image: refused with a plain message, nothing filed.
    expect(await (await post("/api/inputs", { ...b, clientId: "shots-client-2", images: [big] })).json()).toEqual({ error: "a screenshot is at most 8 MB" });
    expect((await (await post("/api/inputs", { ...b, clientId: "shots-client-3", images: [a, a, a, a, a] })).json()).error).toMatch(/at most 4 screenshots/);
    expect(await (await post("/api/inputs", { ...b, clientId: "shots-client-4", images: ["f".repeat(64) + ".png"] })).json()).toEqual({ error: "a screenshot did not upload; add it again" });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.office.filed).toHaveLength(1);
  });
});
