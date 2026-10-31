// An office the tests control: a board, a roster, and a message log.
import type { Agent, Office, Task } from "../src/office";
import { FakeInbox } from "../src/fake-inbox";

export class FakeOffice implements Office {
  inbox = new FakeInbox();
  board = new Map<string, Task>();
  roster: Agent[] = [{ id: "agent-curator-1", name: "Isomux Curator" }];
  sent: { text: string; to: string }[] = [];
  failSends = 0;
  // Round q1, I: the tasks the app filed, and how the next ones fail.
  filed: { title: string; description: string; roomId: string }[] = [];
  failTasks: string[] = [];
  reads: string[] = [];

  put(t: Partial<Task> & { id: string }): void {
    const old = this.board.get(t.id);
    const v = String(Number(old?.version ?? "0") + 1);
    this.board.set(t.id, { title: "A task", status: "open", priority: "P2", createdAt: 1, roomId: "e6818e47", ...old, ...t, version: v });
  }
  async tasks(roomId: string) {
    // As the office lists a board: open and in progress, P0-P3 or no priority.
    return [...this.board.values()].filter((t) => t.roomId === roomId && ["open", "in_progress"].includes(t.status) && (t.priority == null || ["P0", "P1", "P2", "P3"].includes(t.priority)));
  }
  async task(id: string) {
    this.reads.push(id);
    return this.board.get(id) ?? null;
  }
  async agents() {
    // No live owner agent: the office refuses the app's reads (4a1e58c9).
    if (this.inbox.noOwner) throw new Error("GET /agents answered 403");
    return this.roster;
  }
  async message(text: string, to: string) {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error("POST /api/app/message answered 502");
    }
    this.sent.push({ text, to });
  }
  async createTask(t: { title: string; description: string; roomId: string }) {
    const fail = this.failTasks.shift();
    if (fail) throw new Error(fail);
    this.filed.push(t);
    return { id: `task${this.filed.length}` };
  }
  asks() {
    return this.inbox.listAsks();
  }
  answerAsk(id: string, how: "reply" | "dismiss" | "file-task", text: string) {
    return this.inbox.answerAsk(id, how, text);
  }
  pages() {
    return this.inbox.listPages();
  }
  page(id: string) {
    return this.inbox.page(id);
  }
  ackPage(id: string) {
    return this.inbox.ackPage(id);
  }
  file(agentId: string, filename: string, max: number) {
    return this.inbox.file(agentId, filename, max);
  }
}
