// The isomux board source (DESIGN.md section 8): reads a room's board and
// emits board.task.* through the engine's source route. Its state is the
// projection of the logged board.* events, so a restart diffs against the
// log. Read only: it never writes the board.

import type { Engine } from "./engine";
import type { Office, Task } from "./office";

// description: slice 8 (Wall Game triage reads it); older events have none.
export type BoardTask = { title: string; priority: string | null; status: string; assignee: string | null; version: string; createdBy: string; createdAt: number; description?: string };
export type PollReport = { seen: number; filed: number; changed: number; closed: number; errors: string[] };

const LOOP = ["P0", "P1", "P2", "P3"];

function snapshot(t: Task): BoardTask {
  return { title: t.title, priority: t.priority ?? null, status: t.status, assignee: t.assignee ?? null, version: t.version, createdBy: t.createdBy ?? "", createdAt: t.createdAt, description: t.description ?? "" };
}

export class BoardSource {
  constructor(
    private engine: Engine,
    private office: Office,
    readonly project: string,
    readonly source: string,
    readonly roomId: string,
  ) {}

  // What the log says the board is: the last board event per task.
  known(): Map<string, BoardTask & { closed: boolean }> {
    const by = `code:source/${this.source}`;
    const out = new Map<string, BoardTask & { closed: boolean }>();
    for (const e of this.engine.log.all())
      if (e.project === this.project && e.by === by && e.type.startsWith("board.task.")) out.set(e.subject!, { ...e.data, closed: e.type === "board.task.closed" });
    return out;
  }

  private everRead(): boolean {
    const by = `code:source/${this.source}`;
    return this.engine.log.all().some((e) => e.project === this.project && e.by === by);
  }

  async poll(): Promise<PollReport> {
    const out: PollReport = { seen: 0, filed: 0, changed: 0, closed: 0, errors: [] };
    const first = !this.everRead();
    const tasks = await this.office.tasks(this.roomId);
    const known = this.known();
    const listed = new Set<string>();
    const emit = (type: string, id: string, data: object, version: string) =>
      this.engine.sourceEvent({ project: this.project, source: this.source, type, subject: id, data, key: `${type}|${id}|${version}` });
    for (const t of tasks) {
      if (t.roomId !== undefined && t.roomId !== this.roomId) continue;
      listed.add(t.id);
      const k = known.get(t.id);
      const snap = snapshot(t);
      if (!k) {
        // Only the first read ever emits seen; a task new after it is filed.
        emit(first ? "board.task.seen" : "board.task.filed", t.id, snap, t.version);
        first ? out.seen++ : out.filed++;
      } else if (k.closed || k.version !== t.version) {
        // A task that came back (reopened, or raised from P4) is a change.
        emit("board.task.changed", t.id, snap, t.version);
        out.changed++;
      }
    }
    // A task that left the listing: closed, moved to P4, moved out of the
    // room, or deleted. Read it to know which.
    for (const [id, k] of known) {
      // A task known at P4 is not read one by one: it comes back as a change
      // when it returns to the listing. A task with no priority is listed
      // (slice 8: Wall Game has one), so it is read like P0-P3.
      if (k.closed || listed.has(id) || (k.priority !== null && !LOOP.includes(k.priority))) continue;
      try {
        const t = await this.office.task(id);
        if (!t || (t.roomId ?? "") !== this.roomId) {
          emit("board.task.closed", id, { ...k, status: "gone" }, `gone-${k.version}`);
          out.closed++;
        } else if (t.status === "done" || t.status === "obsolete") {
          emit("board.task.closed", id, snapshot(t), t.version);
          out.closed++;
        } else if (t.version !== k.version) {
          emit("board.task.changed", id, snapshot(t), t.version);
          out.changed++;
        }
      } catch (err) {
        out.errors.push(`${id}: ${(err as Error).message}`);
      }
    }
    return out;
  }
}
