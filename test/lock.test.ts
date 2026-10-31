import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTime, takeLock } from "../src/lock";
import { cleanup, engine, tempDir } from "./helpers";

afterAll(cleanup);

const lock = (dir: string, pid: number, start: string | null) => writeFileSync(join(dir, "antifeed.lock"), JSON.stringify({ pid, start }));

test("a data dir held by another live process refuses the start", () => {
  const dir = tempDir();
  lock(dir, process.ppid, startTime(process.ppid));
  expect(() => engine(dir)).toThrow(/in use by process/);
});

test("a dead holder, a reused pid (other start time) or a damaged file is taken over", () => {
  for (const [pid, start] of [[999999999, "1"], [process.ppid, "0"]] as const) {
    const dir = tempDir();
    lock(dir, pid, start);
    const release = takeLock(dir);
    expect(JSON.parse(readFileSync(join(dir, "antifeed.lock"), "utf8"))).toEqual({ pid: process.pid, start: startTime(process.pid) });
    release();
    expect(existsSync(join(dir, "antifeed.lock"))).toBe(false);
  }
  const dir = tempDir();
  writeFileSync(join(dir, "antifeed.lock"), "12");
  takeLock(dir)();
});

test("the same process may open its data dir again; close releases the lock", () => {
  const dir = tempDir();
  const a = engine(dir);
  const b = engine(dir);
  b.e.close();
  a.e.close();
  expect(existsSync(join(dir, "antifeed.lock"))).toBe(false);
});

test("a data dir that does not exist yet is made", () => {
  const { e } = engine(join(tempDir(), "new", "data"));
  expect(e.log.all().map((x) => x.type)).toEqual(["policies.loaded", "batch.end"]);
  e.close();
});
