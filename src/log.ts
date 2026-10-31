// The event log (DESIGN.md section 4): events.jsonl, one Event per line,
// written in batches. A batch is the input event and every event it caused,
// in one write with one fsync, ended by a batch.end line.

import { closeSync, existsSync, fstatSync, statSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Event, EventDraft } from "./types";

export type Ids = { next(prefix: string): string };

// Time-ordered ids: 12 hex digits of ms, then a counter and random digits.
export function realIds(now: () => number = Date.now): Ids {
  let last = 0;
  let n = 0;
  return {
    next(prefix) {
      const t = now();
      n = t === last ? n + 1 : 0;
      last = t;
      const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
      return `${prefix}_${t.toString(16).padStart(12, "0")}${n.toString(16).padStart(4, "0")}${rand}`;
    },
  };
}

export class EventLog {
  readonly file: string;
  private seq = 0;
  // The file size after the last good write: any other size means bytes
  // this log did not write (another process, a failed write left behind).
  private size = 0;
  private events: Event[] = [];
  // A torn tail moved away at load, for the status view.
  torn: string | null = null;
  // A failed write that could not be undone: no more input until a restart.
  broken: string | null = null;

  constructor(
    readonly dir: string,
    private ids: Ids,
    private now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "events.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    const events: Event[] = [];
    let open: string | null = null;
    // Byte offset of the first line of the last batch that has no end.
    let goodEnd = 0;
    let offset = 0;
    let tornAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = offset + Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0);
      if (line.trim() === "") {
        offset = next;
        continue;
      }
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch {
        // Only the last unfinished line can be torn. A damaged line with a
        // complete line after it is damage, not a crash during a write.
        if (lines.slice(i + 1).some((l) => l.trim() !== "")) throw new Error(`events.jsonl line ${i + 1} is damaged; it is not the last line, so it is not a torn write`);
        tornAt = i;
        break;
      }
      if (open !== null && e.batch !== open) throw new Error(`events.jsonl line ${i + 1}: batch ${open} has no batch.end`);
      open = e.batch;
      events.push(e);
      if (e.type === "batch.end") {
        open = null;
        goodEnd = next;
      }
      offset = next;
    }
    if (open !== null || tornAt >= 0) {
      // A crash during a write: the batch never got its fsync, so its
      // request got no answer. Drop it whole.
      const buf = readFileSync(this.file);
      this.torn = join(this.dir, `events.torn-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`);
      writeFileSync(this.torn, buf.subarray(goodEnd));
      const keep = join(this.dir, "events.jsonl.tmp");
      writeFileSync(keep, buf.subarray(0, goodEnd));
      renameSync(keep, this.file);
      while (events.length && events[events.length - 1].type !== "batch.end") events.pop();
    }
    this.events = events;
    this.seq = events.length ? events[events.length - 1].seq : 0;
    this.size = statSync(this.file).size;
  }

  all(): readonly Event[] {
    return this.events;
  }

  // Gives each draft its seq, id, time and the batch id, adds batch.end,
  // writes all lines in one write and fsyncs. Returns the events without
  // batch.end. Nothing is in memory until the fsync returns.
  append(drafts: EventDraft[], at: string = new Date(this.now()).toISOString()): Event[] {
    const batch = this.ids.next("b");
    let seq = this.seq;
    const out: Event[] = drafts.map((d) => ({ ...d, seq: ++seq, id: d.id ?? this.ids.next("e"), at, batch }) as Event);
    const end: Event = { seq: ++seq, id: this.ids.next("e"), at, type: "batch.end", by: "code:engine", batch, data: { n: out.length } };
    const text = [...out, end].map((e) => JSON.stringify(e)).join("\n") + "\n";
    if (this.broken) throw new Error(`the event log takes no input until a restart: ${this.broken}`);
    const fd = openSync(this.file, "a");
    const size = fstatSync(fd).size;
    if (size !== this.size) {
      closeSync(fd);
      this.broken = `events.jsonl is ${size} bytes, but this log last wrote it at ${this.size}: another writer, or bytes left by a failed write`;
      throw new Error(`the event log takes no input until a restart: ${this.broken}`);
    }
    try {
      this.writeAll(fd, text);
      fsyncSync(fd);
    } catch (err) {
      // Some bytes may be on disk: cut the file back, so the next batch does
      // not start on a broken line.
      try {
        this.cutBack(fd, size);
      } catch (cut) {
        this.broken = `a write failed (${(err as Error).message}) and the cut back failed (${(cut as Error).message})`;
      }
      throw err;
    } finally {
      closeSync(fd);
    }
    this.seq = seq;
    this.size = size + Buffer.byteLength(text);
    this.events.push(...out, end);
    return out;
  }

  protected cutBack(fd: number, size: number): void {
    ftruncateSync(fd, size);
    fsyncSync(fd);
  }

  // One write of the whole batch (tests replace it to simulate a full disk).
  protected writeAll(fd: number, text: string): void {
    const buf = Buffer.from(text);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off);
  }
}
