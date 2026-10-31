// One writer per data dir: a lock file with the pid and the process start
// time (field 22 of /proc/<pid>/stat), so a pid reused after a reboot does
// not hold the lock. The file is made with O_EXCL; a dead lock is taken over
// by a rename, and read back to check who won.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

type Holder = { pid: number; start: string };

export function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is in parentheses and can hold spaces.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

const me = (): Holder => ({ pid: process.pid, start: startTime(process.pid) ?? "" });
const same = (a: Holder | null, b: Holder) => !!a && a.pid === b.pid && a.start === b.start;

function read(file: string): Holder | null {
  try {
    const h = JSON.parse(readFileSync(file, "utf8")) as Holder;
    return Number.isInteger(h.pid) && typeof h.start === "string" ? h : null;
  } catch {
    return null;
  }
}

// The holder's process still runs: the same pid with the same start time.
const live = (h: Holder | null) => !!h && startTime(h.pid) === h.start;

export function takeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "antifeed.lock");
  const mine = me();
  const text = JSON.stringify(mine);
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, text);
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const h = read(file);
    if (!same(h, mine)) {
      if (live(h)) throw new Error(`the data dir ${dir} is in use by process ${h!.pid}`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      if (!same(read(file), mine)) throw new Error(`the data dir ${dir} was taken by another process during the start`);
    }
  }
  return () => {
    if (existsSync(file) && same(read(file), mine)) rmSync(file);
  };
}
