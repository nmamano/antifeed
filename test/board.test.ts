import { afterAll, describe, expect, test } from "bun:test";
import { BoardSource } from "../src/board";
import { FakeOffice } from "./fake-office";
import { engine, tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const boardTypes = (e: ReturnType<typeof engine>["e"]) => e.log.all().filter((x) => x.type.startsWith("board.")).map((x) => `${x.type} ${x.subject}`);

describe("board source", () => {
  test("first read: seen; then filed, changed and closed from the diff against the log", async () => {
    const office = new FakeOffice();
    office.put({ id: "t1", title: "Fix the login button" });
    office.put({ id: "t2", title: "[go | ready] Tagged already" });
    const { e } = engine(tempDir());
    const s = new BoardSource(e, office, "isomux", "board", "e6818e47");
    expect(await s.poll()).toMatchObject({ seen: 2, filed: 0 });
    expect(await s.poll()).toMatchObject({ seen: 0, filed: 0, changed: 0, closed: 0 });
    expect([...e.cards.values()].map((c) => c.subject)).toEqual(["t1"]);

    office.put({ id: "t3", title: "New" });
    office.put({ id: "t2", priority: "P1" });
    office.put({ id: "t1", status: "done" });
    office.put({ id: "t4", title: "Elsewhere", roomId: "other" });
    expect(await s.poll()).toMatchObject({ filed: 1, changed: 1, closed: 1 });
    expect([...e.cards.values()].find((c) => c.subject === "t1")!.state).toBe("withdrawn");

    // Moved to P4: one read says so; later polls do not read it again.
    office.put({ id: "t3", priority: "P4" });
    await s.poll();
    office.reads = [];
    await s.poll();
    expect(office.reads).toEqual([]);
    // Deleted: closed as gone.
    office.board.delete("t2");
    await s.poll();
    expect(boardTypes(e)).toEqual([
      "board.task.seen t1", "board.task.seen t2", "board.task.changed t2", "board.task.filed t3", "board.task.closed t1",
      "board.task.changed t3", "board.task.closed t2",
    ]);
    expect(e.log.all().filter((x) => x.type === "board.task.closed").at(-1)!.data.status).toBe("gone");
  });

  test("slice 8: a task's description comes with it, and a task with no priority that leaves the listing is read one by one", async () => {
    const office = new FakeOffice();
    office.put({ id: "t1", priority: null, description: "Words." });
    const { e } = engine(tempDir());
    const s = new BoardSource(e, office, "isomux", "board", "e6818e47");
    await s.poll();
    expect(e.log.all().find((x) => x.type === "board.task.seen")!.data).toMatchObject({ priority: null, description: "Words." });
    office.put({ id: "t1", status: "done" });
    office.reads = [];
    expect(await s.poll()).toMatchObject({ closed: 1 });
    expect(office.reads).toEqual(["t1"]);
  });

  test("a restart diffs against the log and emits nothing new", async () => {
    const office = new FakeOffice();
    office.put({ id: "t1" });
    const dir = tempDir();
    const a = engine(dir);
    await new BoardSource(a.e, office, "isomux", "board", "e6818e47").poll();
    const b = engine(dir, { clock: a.clock });
    const r = await new BoardSource(b.e, office, "isomux", "board", "e6818e47").poll();
    expect(r).toMatchObject({ seen: 0, filed: 0, changed: 0, closed: 0 });
  });
});
