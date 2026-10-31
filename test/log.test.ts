import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog, realIds } from "../src/log";
import { tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const ev = (type: string) => ({ type, by: "code:test" as const, data: {} });

describe("event log", () => {
  test("a batch is written whole, with seq, one batch id and batch.end, and loads back", () => {
    const dir = tempDir();
    const log = new EventLog(dir, realIds());
    log.append([ev("a"), ev("b")]);
    log.append([ev("c")]);
    const again = new EventLog(dir, realIds());
    expect(again.all().map((e) => [e.seq, e.type])).toEqual([[1, "a"], [2, "b"], [3, "batch.end"], [4, "c"], [5, "batch.end"]]);
    expect(new Set(again.all().slice(0, 3).map((e) => e.batch)).size).toBe(1);
    again.append([ev("d")]);
    expect(again.all().at(-2)!.seq).toBe(6);
  });

  test("a batch with no batch.end is dropped whole and kept apart", () => {
    const dir = tempDir();
    const log = new EventLog(dir, realIds());
    log.append([ev("a")]);
    const file = join(dir, "events.jsonl");
    const good = readFileSync(file, "utf8");
    appendFileSync(file, JSON.stringify({ seq: 3, id: "e_x", at: "", type: "b", by: "code:test", batch: "b_torn", data: {} }) + "\n" + '{"seq":4,"id":"e_y","ty');
    const again = new EventLog(dir, realIds());
    expect(again.all().map((e) => e.type)).toEqual(["a", "batch.end"]);
    expect(readFileSync(file, "utf8")).toBe(good);
    expect(again.torn && existsSync(again.torn)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("events.torn-"))).toHaveLength(1);
  });

  test("a batch with no end in the middle of the file is an error, not a silent drop", () => {
    const dir = tempDir();
    const line = (o: object) => JSON.stringify({ at: "", by: "code:test", data: {}, ...o });
    writeFileSync(join(dir, "events.jsonl"), [line({ seq: 1, id: "e1", type: "a", batch: "b1" }), line({ seq: 2, id: "e2", type: "a", batch: "b2" }), line({ seq: 3, id: "e3", type: "batch.end", batch: "b2" })].join("\n") + "\n");
    expect(() => new EventLog(dir, realIds())).toThrow(/b1 has no batch.end/);
  });
});

// A log whose next write puts half its bytes on disk and then fails.
class FullDisk extends EventLog {
  failNext = false;
  failCut = false;
  protected writeAll(fd: number, text: string): void {
    if (!this.failNext) return super.writeAll(fd, text);
    this.failNext = false;
    super.writeAll(fd, text.slice(0, Math.floor(text.length / 2)));
    throw new Error("ENOSPC: no space left on device");
  }
  protected cutBack(fd: number, size: number): void {
    if (this.failCut) throw new Error("EIO");
    super.cutBack(fd, size);
  }
}

describe("damage and failed writes", () => {
  test("a damaged line with complete lines after it is an error, not a torn tail", () => {
    const dir = tempDir();
    const log = new EventLog(dir, realIds());
    for (let i = 0; i < 5; i++) log.append([ev("a"), ev("b")]);
    const file = join(dir, "events.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    lines[3] = lines[3].slice(0, 10);
    writeFileSync(file, lines.join("\n"));
    expect(() => new EventLog(dir, realIds())).toThrow(/line 4 is damaged/);
    expect(readdirSync(dir).filter((f) => f.startsWith("events.torn-"))).toHaveLength(0);
  });

  test("a failed write is cut back, so the next batch is whole", () => {
    const dir = tempDir();
    const log = new FullDisk(dir, realIds());
    log.append([ev("a")]);
    log.failNext = true;
    expect(() => log.append([ev("lost")])).toThrow(/ENOSPC/);
    log.append([ev("c")]);
    expect(new EventLog(dir, realIds()).all().map((e) => e.type)).toEqual(["a", "batch.end", "c", "batch.end"]);
  });

  test("when the cut back fails too, the log takes no input until a restart", () => {
    const dir = tempDir();
    const log = new FullDisk(dir, realIds());
    log.failNext = true;
    log.failCut = true;
    expect(() => log.append([ev("a")])).toThrow(/ENOSPC/);
    expect(() => log.append([ev("b")])).toThrow(/no input until a restart/);
  });
});

test("bytes the log did not write stop the input, so no batch starts on a broken line", () => {
  const dir = tempDir();
  const log = new EventLog(dir, realIds());
  log.append([ev("a")]);
  appendFileSync(join(dir, "events.jsonl"), '{"seq":999,"id":"x","batch":"b_partial"');
  expect(() => log.append([ev("b")])).toThrow(/another writer, or bytes left/);
  expect(() => log.append([ev("c")])).toThrow(/no input until a restart/);
  // A restart sees the partial bytes as a torn tail and drops them.
  expect(new EventLog(dir, realIds()).all().map((e) => e.type)).toEqual(["a", "batch.end"]);
});
