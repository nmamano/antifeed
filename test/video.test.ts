// Wall Game video review (Nil, 2026-10-30). A fake game-video app stands for
// the live one (port 21006): its review queue, its videos and its routes. The
// source copies a video into blobs and opens a card (the caption, the video);
// Nil's call presses the app's route after the call's hold, with the hashes
// of what he saw and the member header; Undo in the hold presses nothing; a
// new render is the card's next packet version; an item gone from the queue
// withdraws the card; a 4xx is a failure card with the app's words. Wall
// Game PM's conditions: the app gets Nil's note with the line "(via
// Antifeed)"; a video changed or gone at the read right before the press
// presses nothing; no safe default, so a stand-in fills in nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Blobs } from "../src/blobs";
import { CALL_HOLD_MS, Dispatcher } from "../src/dispatcher";
import { COPY_RETRY_MS, GameVideoSource } from "../src/game-video";
import { checkProject, definePolicies, folderHash } from "../src/policies";
import { buildView } from "../src/view";
import wallgame from "../projects/wallgame/policies";
import { NOT_SENT_CHANGED, NOT_SENT_GONE, setVideoUrl, VIDEO_IN_ANTIFEED, VIDEO_MEMBER, videoApp, videoParts, wallgameVideo } from "../projects/wallgame/video";
import { codeVote } from "../src/standin";
import type { Card, DecisionLine } from "../src/types";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";

afterAll(cleanup);
const PATH = new URL("../projects/wallgame/video.ts", import.meta.url).pathname;
const MP4 = (n: number) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, n]);

type QItem = { id: string; videoSha256: string; copySha256: string; caption: string; youtubeTitle: string | null; approveProblem: string | null; claimRiskSounds: string[]; noStory: string | null; version: number; scriptCarried: string | null };
const app = { items: new Map<string, QItem>(), presses: [] as { path: string; body: string; member: string | null; name: string | null }[], reads: [] as (string | null)[], videoGets: 0, videoFail: false, fail: null as null | { status: number; error: string }, server: null as ReturnType<typeof Bun.serve> | null };
beforeAll(() => {
  app.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const member = req.headers.get("x-isomux-member-id");
      // The app's memberOf: the name header, URI-decoded.
      const name = decodeURIComponent(req.headers.get("x-isomux-member-name") ?? "");
      if (member !== VIDEO_MEMBER.id) return Response.json({ error: "only Nil reviews" }, { status: 403 });
      if (req.method === "GET" && u.pathname === "/api/review/queue") {
        app.reads.push(member);
        return Response.json({ items: [...app.items.values()], approved: [], canReview: true });
      }
      if (req.method === "GET" && u.pathname === "/api/daily/video") {
        app.reads.push(member);
        app.videoGets++;
        if (app.videoFail) return new Response("no", { status: 404 });
        const it = app.items.get(u.searchParams.get("item") ?? "");
        return it ? new Response(MP4(it.videoSha256.charCodeAt(0)), { headers: { "Content-Type": "video/mp4" } }) : new Response("no", { status: 404 });
      }
      const m = u.pathname.match(/^\/api\/review\/([^/]+)\/(approve|revise|discard|withdraw)$/);
      if (req.method === "POST" && m) {
        const body = await req.text();
        app.presses.push({ path: `${m[2]} ${m[1]}`, body, member, name });
        if (app.fail) return Response.json({ error: app.fail.error }, { status: app.fail.status });
        app.items.delete(m[1]);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  setVideoUrl(`http://127.0.0.1:${app.server.port}`);
});
afterAll(() => app.server?.stop(true));

const item = (id: string, over: Partial<QItem> = {}): QItem => ({ id, videoSha256: "a".repeat(64), copySha256: "c".repeat(64), caption: `bro built a maze and the bot got lost in it #wallgame ${id}`, youtubeTitle: null, approveProblem: null, claimRiskSounds: [], noStory: null, version: 1, scriptCarried: null, ...over });

// The video kind alone, with no Premove agent: the card opens at once.
const def = definePolicies({
  project: "wallgame",
  actors: [...videoParts(true).actors, { id: "nil", kind: "human", member: "Nil" }],
  sources: videoParts(true).sources,
  events: videoParts(true).events,
  policies: [{ ...wallgameVideo, decider: { kind: "nil", predictor: { kind: "code", handler: "none" } } }],
  handlers: { none: () => ({ kind: "ask", prediction: null }) },
  run: { videoapp: videoApp },
});

function setup() {
  app.items.clear();
  app.presses = [];
  app.reads = [];
  app.videoGets = 0;
  app.videoFail = false;
  app.fail = null;
  const dir = tempDir();
  const open = () => engine(dir, { projects: [{ def, path: PATH, hash: folderHash(PATH) }], predict: fakePredict().rt });
  const x = open();
  const blobs = new Blobs(dir);
  const source = new GameVideoSource(x.e, blobs, "wallgame", "video", `http://127.0.0.1:${app.server!.port}`, VIDEO_MEMBER, undefined, () => x.clock.t);
  const d = new Dispatcher(x.e, new FakeOffice(), "http://127.0.0.1:1", () => x.clock.t);
  return { ...x, dir, open, blobs, source, d };
}
type S = ReturnType<typeof setup>;
const cardOf = (s: S, id: string) => [...s.e.cards.values()].filter((c) => c.policy === "wallgame-video" && c.subject === id).at(-1)!;
async function waiting(s: S, it: QItem) {
  app.items.set(it.id, it);
  await s.source.poll();
  await s.e.settle();
  return cardOf(s, it.id);
}
async function release(s: S) {
  await s.d.tick();
  s.clock.t += CALL_HOLD_MS + 1;
  await s.d.tick();
}

describe("Wall Game video review", () => {
  test("the project passes the load check; the switch off loads nothing", () => {
    expect(checkProject(def)).toEqual([]);
    expect(checkProject(wallgame)).toEqual([]);
    expect(wallgame.policies.some((p) => p.id === "wallgame-video")).toBe(VIDEO_IN_ANTIFEED);
    const off = videoParts(false);
    expect([off.policies, off.sources, off.actors, off.run]).toEqual([[], [], [], {}]);
  });

  test("a video in review: a card with the caption, the video in blobs, and the page's lines; the member header on every read", async () => {
    const s = setup();
    const c = await waiting(s, item("v1", { youtubeTitle: "The bot got lost", claimRiskSounds: ["boom"], noStory: "No Instagram Story: the video is too long.", scriptCarried: "The script is the one from v0." }));
    expect(c.state).toBe("open");
    expect(c.packet!.question).toBe("bro built a maze and the bot got lost in it #wallgame v1");
    const [v, ...rest] = c.packet!.blocks;
    expect(v.type).toBe("video");
    expect(s.blobs.get((v as { blob: string }).blob, null)).toBeTruthy();
    expect(rest.map((b) => (b.type === "markdown" ? [b.text, b.tone ?? ""] : b.type))).toEqual([["YouTube: The bot got lost", ""], ["Sound with a high claim risk: boom", "warn"], ["No Instagram Story: the video is too long.", "warn"], "fold"]);
    expect(app.reads.every((m) => m === VIDEO_MEMBER.id)).toBe(true);
    // A second read with nothing new emits nothing.
    expect(await s.source.poll()).toMatchObject({ waiting: 0, left: 0 });
    const vc = buildView({ engine: s.e, agents: () => new Map(), folderOf: () => undefined, chatUrl: "" }).cards.find((x: { id: string }) => x.id === c.id) as { policy: string };
    expect(vc.policy).toBe("wallgame-video");
  });

  test("Approve presses the route after the hold, with the hashes Nil saw and the member header", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "approve" } });
    await s.d.tick();
    expect(app.presses).toEqual([]);
    await release(s);
    expect(app.presses).toHaveLength(1);
    expect(app.presses[0]).toMatchObject({ path: "approve v1", member: VIDEO_MEMBER.id, name: "Nil" });
    expect(JSON.parse(app.presses[0].body)).toEqual({ notes: "(via Antifeed)", videoSha256: "a".repeat(64), copySha256: "c".repeat(64) });
    // After the press the Undo is refused: the page's Approved tab has Undo approval.
    expect(() => s.e.undo(MEMBER, c.id)).toThrow(/Approved tab/);
    // The video left the queue: the decided card stays decided.
    await s.source.poll();
    expect(cardOf(s, "v1").state).toBe("decided");
    s.e.close();
    expect(s.open().e.replayDiffs).toEqual([]);
  });

  test("Undo inside the hold presses nothing", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "discard", note: "Too dark." } });
    await s.d.tick();
    s.e.undo(MEMBER, c.id);
    await release(s);
    expect(app.presses).toEqual([]);
    expect(cardOf(s, "v1")).toMatchObject({ id: c.id, state: "open" });
  });

  test("Revise and Discard need a note; Approve is refused when the page says it cannot be taken", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    expect(() => s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "revise" } })).toThrow("Write a note first: what should change?");
    expect(() => s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "discard", note: "  " } })).toThrow("Write a note first: why discard it?");
    const c2 = await waiting(s, item("v2", { approveProblem: "another video of the game posts first" }));
    expect(() => s.e.decide(MEMBER, c2.id, { version: c2.version, call: { action: "approve" } })).toThrow("Approve cannot be taken now: another video of the game posts first");
    s.e.decide(MEMBER, c2.id, { version: c2.version, call: { action: "revise", note: "Shorter, please." } });
    await release(s);
    expect(app.presses.map((p) => [p.path, JSON.parse(p.body).notes])).toEqual([["revise v2", "Shorter, please.\n(via Antifeed)"]]);
  });

  test("the app gets Nil's note, then the line (via Antifeed); the card and the decision log keep his note alone", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    const note = "Too dark.\nTry the day board.";
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "discard", note } });
    await release(s);
    expect(JSON.parse(app.presses[0].body).notes).toBe(`${note}\n(via Antifeed)`);
    expect(s.e.cards.get(c.id)!.decision!.call.note).toBe(note);
    expect((s.e.decisions.all().find((l) => "card" in l && l.card === c.id) as DecisionLine).call.note).toBe(note);
    // A note too long for the app (4000 characters with the line) is refused before the call.
    const c2 = await waiting(s, item("v2"));
    expect(() => s.e.decide(MEMBER, c2.id, { version: c2.version, call: { action: "revise", note: "x".repeat(3990) } })).toThrow(/The note is too long/);
  });

  test("the queue read right before the press: a changed or gone video presses nothing; the next read opens a new card for a changed one", async () => {
    const s = setup();
    const c1 = await waiting(s, item("v1"));
    const c2 = await waiting(s, item("v2"));
    s.e.decide(MEMBER, c1.id, { version: c1.version, call: { action: "approve" } });
    s.e.decide(MEMBER, c2.id, { version: c2.version, call: { action: "approve" } });
    // No read of the queue between the call and the press.
    app.items.set("v1", item("v1", { copySha256: "d".repeat(64) }));
    app.items.delete("v2");
    await release(s);
    await s.e.settle();
    expect(app.presses).toEqual([]);
    const ks = [...s.e.commands.values()].filter((k) => k.type === "video.apply");
    expect(ks.map((k) => [k.subject, k.state, (k.result as { notSent?: string }).notSent])).toEqual([["v1", "done", NOT_SENT_CHANGED], ["v2", "done", NOT_SENT_GONE]]);
    expect(NOT_SENT_CHANGED).toContain("the video changed since you saw it");
    await s.source.poll();
    await s.e.settle();
    const n1 = cardOf(s, "v1");
    expect(n1.id).not.toBe(c1.id);
    expect(n1.state).toBe("open");
    expect(cardOf(s, "v2").id).toBe(c2.id);
    // The new card's call goes with the hashes it shows.
    s.e.decide(MEMBER, n1.id, { version: n1.version, call: { action: "approve" } });
    await release(s);
    expect(app.presses).toHaveLength(1);
    expect(JSON.parse(app.presses[0].body).copySha256).toBe("d".repeat(64));
  });

  test("a video changed right before the press and back as Nil saw it by the next read gets a new card", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "approve" } });
    app.items.set("v1", item("v1", { copySha256: "d".repeat(64) }));
    await release(s);
    await s.e.settle();
    expect(app.presses).toEqual([]);
    // Changed back inside one read: the same as the log has it.
    app.items.set("v1", item("v1"));
    expect(await s.source.poll()).toMatchObject({ waiting: 1 });
    await s.e.settle();
    const n = cardOf(s, "v1");
    expect(n.id).not.toBe(c.id);
    expect(n.state).toBe("open");
    // Once only: the next read with nothing new emits nothing.
    expect(await s.source.poll()).toMatchObject({ waiting: 0, left: 0 });
    s.e.close();
    expect(s.open().e.replayDiffs).toEqual([]);
  });

  test("no safe default: a stand-in fills in nothing and runs no model; only the Predictor's Premove fills in a call", async () => {
    expect(wallgameVideo.fallback).toBeUndefined();
    expect(checkProject({ ...def, policies: [{ ...wallgameVideo, fallback: { action: "approve" } }] })).toContain('policy "wallgame-video": a policy with noDefault names no fallback call');
    // The real decider (Wall Game Consult predicts) in a project with no consult agent: the stand-in comes at the next check.
    let runs = 0;
    const consulted = definePolicies({ ...def, policies: [wallgameVideo] });
    const dir = tempDir();
    const x = engine(dir, { projects: [{ def: consulted, path: PATH, hash: folderHash(PATH) }], predict: fakePredict({ standin: async () => (runs++, { call: { action: "approve" }, confidence: 0.9, why: "x", against: "y", by: "agent:standin@sonnet#s1" }) }).rt });
    app.items.clear();
    app.items.set("v1", item("v1"));
    await new GameVideoSource(x.e, new Blobs(dir), "wallgame", "video", `http://127.0.0.1:${app.server!.port}`, VIDEO_MEMBER).poll();
    await x.e.settle();
    expect(x.e.checkPredicts()).toBe(1);
    await x.e.settle();
    const c = [...x.e.cards.values()].find((k) => k.policy === "wallgame-video")!;
    expect(runs).toBe(0);
    expect(c).toMatchObject({ state: "open", prediction: { by: "code:standin", call: {}, confidence: 0, standin: { basis: "none" } } });
    expect(c.prediction!.why).toBe("No basis: no prediction came from the consult agent. Approve posts the video publicly, so nothing is filled in without a prediction.");
    // Past calls give no vote either.
    const past = (i: number): DecisionLine => ({ id: `d${i}`, at: "2026-10-30T10:00:00.000Z", policy: "wallgame-video", project: "wallgame", card: `c${i}`, version: 1, snapshot: { ...c.packet!, options: [], recommended: null, meta: c.meta }, prediction: null, call: { action: "approve" }, by: "human:Nil", outcome: "unpredicted", note: "", shownAt: null, secondsToDecide: null }) as DecisionLine;
    expect(codeVote(wallgameVideo, c as Card, [past(1), past(2), past(3)])).toMatchObject({ basis: "none", call: {} });
  });

  test("a new render is the card's next packet version, with a new blob; the call goes with its hashes", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    const v1 = c.version;
    const blob1 = (c.packet!.blocks[0] as { blob: string }).blob;
    app.items.set("v1", item("v1", { videoSha256: "b".repeat(64) }));
    await s.source.poll();
    await s.e.settle();
    const c2 = cardOf(s, "v1");
    expect(c2.id).toBe(c.id);
    expect(c2.version).toBe(v1 + 1);
    const blob2 = (c2.packet!.blocks[0] as { blob: string }).blob;
    expect(blob2).not.toBe(blob1);
    s.e.decide(MEMBER, c2.id, { version: c2.version, call: { action: "approve" } });
    await release(s);
    expect(JSON.parse(app.presses[0].body).videoSha256).toBe("b".repeat(64));
  });

  test("a new render during the hold: the call is not sent, and a new card shows the video", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "approve" } });
    app.items.set("v1", item("v1", { videoSha256: "b".repeat(64) }));
    await s.source.poll();
    await s.e.settle();
    await release(s);
    expect(app.presses).toEqual([]);
    const c2 = cardOf(s, "v1");
    expect(c2.id).not.toBe(c.id);
    expect(c2.state).toBe("open");
  });

  test("an item gone from the queue withdraws its card", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    app.items.delete("v1");
    expect(await s.source.poll()).toMatchObject({ left: 1 });
    expect(s.e.cards.get(c.id)!.state).toBe("withdrawn");
    expect(s.e.log.all().find((e) => e.type === "card.withdrawn" && e.card === c.id)!.data.reason).toBe("No longer in review.");
  });

  test("a failed video copy is tried again only after 10 minutes, not on every read", async () => {
    const s = setup();
    app.items.set("v1", item("v1"));
    app.videoFail = true;
    expect((await s.source.poll()).errors).toEqual(["v1: the video answered 404"]);
    s.clock.t += COPY_RETRY_MS - 1000;
    expect((await s.source.poll()).errors[0]).toStartWith("v1: the video answered 404 (tried again 10 min after");
    expect(app.videoGets).toBe(1);
    // A new render is a new copy at once.
    app.items.set("v1", item("v1", { videoSha256: "b".repeat(64) }));
    await s.source.poll();
    expect(app.videoGets).toBe(2);
    app.videoFail = false;
    s.clock.t += COPY_RETRY_MS;
    expect(await s.source.poll()).toMatchObject({ waiting: 1, errors: [] });
    expect(app.videoGets).toBe(3);
  });

  test("a 4xx is a failure card with the app's words", async () => {
    const s = setup();
    const c = await waiting(s, item("v1"));
    s.e.decide(MEMBER, c.id, { version: c.version, call: { action: "approve" } });
    app.fail = { status: 409, error: "a newer render is in review" };
    await release(s);
    await s.e.settle();
    const k = [...s.e.commands.values()].find((x) => x.type === "video.apply")!;
    expect(k).toMatchObject({ state: "failed", error: "the video page refused it: a newer render is in review" });
    const f = [...s.e.cards.values()].find((x) => x.policy === "command-failed")!;
    expect(f.packet!.question).toBe("Your Approve on the video page did not go out. The video page refused it: a newer render is in review.");
  });
});
