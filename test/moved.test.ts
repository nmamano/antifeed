// Nil's decision of 2026-10-31 (DESIGN.md 22): Isomux decision work moves
// off Antifeed into the Isomux Inbox, as asks. The isomux project (its
// board, triage, sign-off) and the Inbox project (asks, pages) are not
// loaded; at start their waiting cards are withdrawn with the reason, the log
// keeps them (B4) and GET /api/cards?state=all still lists them.
import { afterAll, describe, expect, test } from "bun:test";
import { makeApi } from "../src/api";
import { Blobs } from "../src/blobs";
import { INBOX, MOVED_TO_INBOX, POLICY_PATHS, TRIAGE, WALLGAME } from "../src/config";
import { InboxSource } from "../src/inbox";
import { folderHash, type ProjectDef } from "../src/policies";
import isomux from "../projects/isomux/policies";
import inbox from "../projects/inbox/policies";
import { SIGNOFF_IN_ANTIFEED } from "../projects/isomux/signoff";
import wallgame from "../projects/wallgame/policies";
import { VIDEO_IN_ANTIFEED } from "../projects/wallgame/video";
import { cleanup, engine, fakePredict, MEMBER, tempDir } from "./helpers";
import { FakeOffice } from "./fake-office";

afterAll(cleanup);
const ISO = new URL("../projects/isomux/policies.ts", import.meta.url).pathname;
const INB = new URL("../projects/inbox/policies.ts", import.meta.url).pathname;
const load = (defs: [ProjectDef, string][]) => defs.map(([def, path]) => ({ def, path, hash: folderHash(path) }));
const inboxWithConsult: ProjectDef = { ...inbox, actors: [...inbox.actors, { id: "consult", kind: "agent", agentName: "Isomux Consult" }], consult: "consult" };

describe("Isomux kinds moved to the Isomux Inbox", () => {
  test("the switches are off: neither the isomux project nor the Inbox project is loaded", () => {
    expect([TRIAGE, SIGNOFF_IN_ANTIFEED, INBOX, VIDEO_IN_ANTIFEED]).toEqual([false, false, false, false]);
    // The wallgame project's file has only triage; its video review moved first.
    expect(wallgame.policies.map((p) => p.id)).toEqual(["wallgame-triage"]);
    // Wall Game triage is off last: no project is loaded.
    expect(WALLGAME).toBe(false);
    expect(POLICY_PATHS).toEqual([]);
    expect(POLICY_PATHS.some((p) => /projects\/(inbox|isomux)\//.test(p))).toBe(false);
    expect([...MOVED_TO_INBOX.policies].sort()).toEqual(["ask", "page", "signoff", "triage", "wallgame-triage", "wallgame-video"]);
  });

  test("at start, every waiting card of a moved kind is withdrawn with the reason, once; the log keeps it and state=all lists it", async () => {
    const dir = tempDir();
    const office = new FakeOffice();
    office.roster = office.inbox.roster = [{ id: "agent-w", name: "Demo Worker", roomId: "r1", roomName: "Demo" }];
    const on = engine(dir, { projects: load([[isomux, ISO], [inboxWithConsult, INB]]), predict: fakePredict().rt });
    const board = (type: string, id: string, data: object) => on.e.sourceEvent({ project: "isomux", source: "board", type, subject: id, data: { status: "open", ...data } });
    board("board.task.seen", "t1", { title: "Waits for its packet", priority: "P2" });
    board("board.task.seen", "t2", { title: "Its prepare fails", priority: "P2" });
    board("board.task.seen", "t3", { title: "Decided before the move", priority: "P2" });
    office.inbox.addAsk({ agentId: "agent-w", prompt: "Ship it now?" });
    await new InboxSource(on.e, office, new Blobs(dir), "inbox", "inbox").poll();
    const prep = (id: string) => [...on.e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === id)!;
    on.e.commandResult(prep("t2").id, { ok: false, error: "the Curator is gone" });
    const k3 = prep("t3");
    on.e.startCommand(k3.id);
    on.e.postPacket({ command: k3.id, packet: { question: "Decided before the move", blocks: [], options: [{ id: "a", label: "Backlog", fill: { choice: "backlog", priority: null } }], recommended: "a" }, meta: { raw: "x" } });
    const c3 = [...on.e.cards.values()].find((c) => c.subject === "t3")!;
    on.e.decide(MEMBER, c3.id, { version: 1, call: { choice: "backlog", priority: null } });
    await on.e.settle();
    const waiting = [...on.e.cards.values()].filter((c) => ["preparing", "predicting", "open"].includes(c.state));
    expect(waiting.map((c) => c.policy).sort()).toEqual(["ask", "command-failed", "triage", "triage"]);
    on.e.close();

    // The switches off: neither project is loaded.
    const off = engine(dir, { projects: [], predict: fakePredict().rt });
    expect(off.e.replayDiffs).toEqual([]);
    const events = off.e.withdrawOff(MOVED_TO_INBOX.policies, MOVED_TO_INBOX.reason);
    // (Their open predicts close with them.)
    expect(events.filter((e) => e.type === "card.withdrawn").map((e) => [e.type, e.by, e.data.reason])).toEqual(waiting.map(() => ["card.withdrawn", "code:engine", "Moved to the Isomux Inbox (Nil, 2026-10-31)."]));
    for (const c of waiting) expect(off.e.cards.get(c.id)!.state).toBe("withdrawn");
    // The decided card keeps its call.
    expect(off.e.cards.get(c3.id)!.state).toBe("decided");
    // Once: the next start withdraws nothing.
    expect(off.e.withdrawOff(MOVED_TO_INBOX.policies, MOVED_TO_INBOX.reason)).toEqual([]);
    // Off (B4): not in the queue; the API lists them with state=all, to read.
    expect(off.e.queue()).toEqual([]);
    const api = makeApi({ engine: off.e, blobs: new Blobs(dir), member: MEMBER, base: "http://x" });
    const get = async (path: string) => (await (await api(new Request(`http://x${path}`))).json()) as { cards: { id: string; policy: string }[] };
    expect((await get("/api/cards")).cards).toEqual([]);
    const all = (await get("/api/cards?state=all")).cards;
    expect(all.filter((c) => c.policy !== "command-failed").map((c) => c.policy).sort()).toEqual(["ask", "triage", "triage", "triage"]);
    expect((await get("/api/cards?state=all&policy=triage")).cards).toHaveLength(3);
    off.e.close();
    expect(engine(dir, { projects: [], predict: fakePredict().rt }).e.replayDiffs).toEqual([]);
  });

  test("a command whose policy is off gets no timeout card; while on, it gets one", async () => {
    const dir = tempDir();
    const clock = { t: Date.parse("2026-10-31T03:00:00Z") };
    const on = engine(dir, { clock, projects: load([[isomux, ISO]]), predict: fakePredict().rt });
    for (const id of ["t1", "t2"]) on.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: id, data: { status: "open", title: `Task ${id}`, priority: "P2" } });
    const k1 = [...on.e.commands.values()].find((k) => k.type === "triage.prepare" && k.subject === "t1")!;
    on.e.delivered(k1.id);
    on.e.close();
    // Off: past the prepare's 2 h timeout, the failure policy's tick names the off commands and opens nothing.
    const off = engine(dir, { clock, projects: [], predict: fakePredict().rt });
    clock.t += 2 * 3_600_000 + 1000;
    expect(off.e.fireWakes()).toBeGreaterThan(0);
    const tick = off.e.log.all().filter((e) => e.type === "clock.tick").at(-1)!;
    expect(tick.data.off).toContain(k1.id);
    expect([...off.e.cards.values()].filter((c) => c.policy === "command-failed")).toEqual([]);
    off.e.close();
    // The same log with triage on replays clean.
    expect(engine(dir, { clock, projects: load([[isomux, ISO]]), predict: fakePredict().rt }).e.replayDiffs).toEqual([]);
  });

  test("while its policy is on, a command past its timeout gets its card", async () => {
    const clock = { t: Date.parse("2026-10-31T03:00:00Z") };
    const on = engine(tempDir(), { clock, projects: load([[isomux, ISO]]), predict: fakePredict().rt });
    on.e.sourceEvent({ project: "isomux", source: "board", type: "board.task.seen", subject: "t1", data: { status: "open", title: "Task t1", priority: "P2" } });
    clock.t += 2 * 3_600_000 + 1000;
    on.e.fireWakes();
    expect([...on.e.cards.values()].filter((c) => c.policy === "command-failed").map((c) => c.packet!.question)).toEqual([expect.stringContaining("no result before its timeout")]);
  });
});
