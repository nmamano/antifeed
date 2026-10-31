// A fake of Nil's Inbox in the office (slice 7), until isomux task 4a1e58c9
// gives the app its reach. It keeps asks, pages and files in memory, with
// the routes and shapes of the office (isomux server/routes/table.ts and
// shared/types.ts, read 2026-10-26). Tests use it directly; the walkthrough
// copy serves it over HTTP under /fake-office, so the app's real office
// client reads it, and the reviewer plays the agents and the Inbox through
// its control routes.

import { type Agent, type Ask, type Attachment, type Page, type Task, TOKEN_REFUSED, type WriteResult } from "./office";

export type Answer = { ask: string; how: "reply" | "dismiss" | "file-task"; text: string; at: number };
// A message the app sent through POST /api/app/message (slice 8: to Wall Game PM).
export type Sent = { text: string; to: string; at: number };

export class FakeInbox {
  asks = new Map<string, Ask>();
  pages = new Map<string, Page>();
  files = new Map<string, { type: string; bytes: Uint8Array }>();
  // What the app sent: answers and acks, in order.
  answers: Answer[] = [];
  acks: string[] = [];
  roster: Agent[] = [];
  // Slice 8: a room's board, as the office lists it, and the app's messages.
  tasks = new Map<string, Task>();
  messages: Sent[] = [];
  // isomux task 4a1e58c9 (Isomux Worker 1, 2026-10-26). switchOff: Nil has
  // not turned on Inbox access for the app, so the asks and their files are
  // 403. noOwner: the app has no live owner agent, so every read is 403,
  // GET /agents too. Each refusal is the same 403.
  switchOff = false;
  noOwner = false;
  // Part N: Nil's API token. When set, the asks, files and pager routes over
  // HTTP need it (Authorization: Bearer); any other caller gets 401.
  nilToken: string | null = null;
  // With nilToken set: the app's token, which the pager routes take too.
  appToken: string | null = null;
  // Part N, as the app's office client: the office refused Nil's token, so
  // each Inbox read and answer fails with the words that name it.
  nilRefused = false;
  // Slice 8 walk: how POST /api/app/message alone fails (the reads still
  // answer): 403, 404 or 502, or "hang" (no answer at all); null sends.
  sendFail: 403 | 404 | 502 | "hang" | null = null;
  // Round q1, I: how POST /api/tasks alone fails: 403, 422 or 502, or "hang"; null files.
  taskFail: 403 | 422 | 502 | "hang" | null = null;
  // Queue round 1 (S1): the board listing fails with a 502, for the Sources checks.
  boardFail = false;
  // Asks with another answer going out now: a write is 409 ask_busy.
  busy = new Set<string>();
  private n = 0;
  constructor(private now: () => number = Date.now) {}

  private id(prefix: string): string {
    return `${prefix}${(++this.n).toString(16).padStart(4, "0")}`;
  }

  // ---- what an agent does -------------------------------------------------

  addAsk(a: Partial<Ask> & { agentId: string; prompt: string }, files: { name: string; type: string; bytes: Uint8Array }[] = []): Ask {
    const t = this.now();
    const readFiles: Attachment[] = files.map((f) => {
      const filename = `${this.id("f")}-${f.name}`;
      this.files.set(`${a.agentId}/${filename}`, { type: f.type, bytes: f.bytes });
      return { filename, originalName: f.name, mediaType: f.type, size: f.bytes.length };
    });
    const ask: Ask = { id: this.id("a"), memberUserId: "m0000000", createdAt: t, updatedAt: t, ...a, ...(readFiles.length ? { readFiles } : {}) };
    this.asks.set(ask.id, ask);
    return ask;
  }
  editAsk(id: string, patch: Partial<Ask>): Ask | null {
    const a = this.asks.get(id);
    if (!a) return null;
    const next = { ...a, ...patch, id, updatedAt: Math.max(this.now(), a.updatedAt + 1) };
    this.asks.set(id, next);
    return next;
  }
  // The agent takes the ask back, or Nil answers it in the Inbox.
  closeAsk(id: string): boolean {
    return this.asks.delete(id);
  }
  raisePage(p: { title: string; body?: string; key?: string; agentId?: string; agentName?: string; roomId?: string; targetUserId?: string }): Page {
    const t = this.now();
    const same = p.key ? [...this.pages.values()].find((x) => x.key === p.key && x.state !== "resolved") : undefined;
    if (same) {
      const next: Page = { ...same, title: p.title, body: p.body, lastRaisedAt: Math.max(t, same.lastRaisedAt + 1), raiseCount: same.raiseCount + 1 };
      if (!p.body) delete next.body;
      this.pages.set(same.id, next);
      return next;
    }
    const page: Page = {
      id: this.id("p"), createdAt: t, lastRaisedAt: t, raiseCount: 1, targetUserId: p.targetUserId ?? "m0000000", state: "open", title: p.title,
      ...(p.body ? { body: p.body } : {}), ...(p.key ? { key: p.key } : {}),
      source: { kind: "agent", agentId: p.agentId ?? "agent-x", name: p.agentName ?? "An agent", roomId: p.roomId ?? "room-x" },
    };
    this.pages.set(page.id, page);
    return page;
  }
  // In the Inbox (acked), or by its source (resolved).
  setPage(id: string, state: "acked" | "resolved"): boolean {
    const p = this.pages.get(id);
    if (!p) return false;
    this.pages.set(id, { ...p, state });
    return true;
  }

  addTask(t: Partial<Task> & { title: string; roomId: string }): Task {
    const task: Task = { id: this.id("t") + "aaaa", status: "open", priority: null, createdAt: this.now(), version: "1", ...t } as Task;
    if (!task.assignee) delete task.assignee;
    this.tasks.set(task.id, task);
    return task;
  }
  editTask(id: string, patch: Partial<Task>): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const next = { ...t, ...patch, id, version: String(Number(t.version) + 1) } as Task;
    if (!next.assignee) delete next.assignee;
    this.tasks.set(id, next);
    return next;
  }

  // ---- the app's reach (the Office methods) --------------------------------

  // The board's default listing: open and in-progress tasks, P0-P3 or no priority.
  listTasks(roomId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.roomId === roomId && (t.status === "open" || t.status === "in_progress") && (t.priority == null || ["P0", "P1", "P2", "P3"].includes(t.priority))).map((t) => structuredClone(t));
  }

  private get asksOff(): boolean {
    return this.switchOff || this.noOwner;
  }
  async agents(): Promise<Agent[]> {
    if (this.noOwner) throw new Error("GET /agents answered 403");
    return structuredClone(this.roster);
  }
  async listAsks(): Promise<Ask[]> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.asksOff) throw new Error("GET /api/asks answered 403");
    // The office lists secret requests too; the app's source must drop them.
    return [...this.asks.values()].map((a) => structuredClone(a));
  }
  async answerAsk(id: string, how: Answer["how"], text: string): Promise<WriteResult> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.asksOff) throw new Error(`POST /api/asks/:id/${how} answered 403`);
    const a = this.asks.get(id);
    if (!a || a.secret) return "gone";
    if (this.busy.has(id)) return "busy";
    this.asks.delete(id);
    this.answers.push({ ask: id, how, text, at: this.now() });
    return "ok";
  }
  async listPages(): Promise<Page[]> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.noOwner) throw new Error("GET /api/pager answered 403");
    return [...this.pages.values()].filter((p) => p.state === "open").map((p) => structuredClone(p));
  }
  async page(id: string): Promise<Page | null> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.noOwner) throw new Error("GET /api/pager/:id answered 403");
    const p = this.pages.get(id);
    return p ? structuredClone(p) : null;
  }
  async ackPage(id: string): Promise<WriteResult> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.noOwner) throw new Error("POST /api/pager/:id/ack answered 403");
    const p = this.pages.get(id);
    if (!p || p.state === "resolved") return "gone";
    this.pages.set(id, { ...p, state: "acked" });
    this.acks.push(id);
    return "ok";
  }
  async file(agentId: string, filename: string, max = Infinity): Promise<{ type: string; bytes: Uint8Array } | null> {
    if (this.nilRefused) throw new Error(TOKEN_REFUSED);
    if (this.asksOff) throw new Error("GET /api/files answered 403");
    const f = this.files.get(`${agentId}/${filename}`) ?? null;
    if (f && f.bytes.length > max) throw new Error(`over the ${max / 2 ** 20} MB that Antifeed keeps`);
    return f;
  }

  // ---- HTTP: the office routes, and the control routes --------------------

  // Answers a request under `prefix` ("/fake-office"), or null for any other path.
  async handle(req: Request, prefix: string): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`${prefix}/`)) return null;
    const path = url.pathname.slice(prefix.length);
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    const forbidden = () => json({ error: { code: "forbidden", message: "forbidden" } }, 403);
    const body = async (): Promise<unknown> => {
      const t = await req.text();
      try {
        return t ? JSON.parse(t) : {};
      } catch {
        return {};
      }
    };
    let m: RegExpMatchArray | null;
    const bearer = req.headers.get("authorization");
    const pager = /^\/api\/pager(\/|$)/.test(path);
    if (this.nilToken && (pager || /^\/api\/(asks|files)(\/|$)/.test(path)) && bearer !== `Bearer ${this.nilToken}` && !(pager && this.appToken && bearer === `Bearer ${this.appToken}`))
      return json({ error: { code: "unauthorized", message: "unauthorized" } }, 401);
    if (req.method === "GET" && path === "/api/asks") return this.asksOff ? forbidden() : json(await this.listAsks());
    if (req.method === "POST" && (m = path.match(/^\/api\/asks\/([^/]+)\/(reply|dismiss|file-task)$/))) {
      if (this.asksOff) return forbidden();
      const b = (await req.json().catch(() => ({}))) as { text?: string };
      if (m[2] === "reply" && !(b.text ?? "").trim()) return json({ error: "text is required" }, 400);
      const r = await this.answerAsk(decodeURIComponent(m[1]), m[2] as Answer["how"], b.text ?? "");
      if (r === "busy") return json({ error: { code: "ask_busy", message: "An answer to this ask is already in flight." } }, 409);
      return r === "gone" ? json({ error: { code: "not_found", message: "No such open ask." } }, 404) : new Response(null, { status: 204 });
    }
    if (req.method === "GET" && path === "/api/pager") return this.noOwner ? forbidden() : json(url.searchParams.get("state") === "open" ? await this.listPages() : [...this.pages.values()]);
    if (req.method === "GET" && (m = path.match(/^\/api\/pager\/([^/]+)$/))) {
      if (this.noOwner) return forbidden();
      const p = await this.page(decodeURIComponent(m[1]));
      return p ? json(p) : json({ error: "not_found" }, 404);
    }
    if (req.method === "POST" && (m = path.match(/^\/api\/pager\/([^/]+)\/ack$/))) {
      if (this.noOwner) return forbidden();
      const p = this.pages.get(decodeURIComponent(m[1]));
      if (!p) return json({ error: "not_found" }, 404);
      if (p.state === "resolved") return json({ error: "resolved" }, 409);
      await this.ackPage(p.id);
      return json(this.pages.get(p.id));
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/files\/([^/]+)\/([^/]+)$/))) {
      if (this.asksOff) return forbidden();
      const f = await this.file(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      return f ? new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": f.type } }) : json({ error: "not_found" }, 404);
    }
    if (req.method === "GET" && path === "/agents") return this.noOwner ? forbidden() : json(this.roster);
    if (req.method === "GET" && path === "/api/tasks") return this.boardFail ? json({ error: { code: "board_fail", message: "Failed by the fake office." } }, 502) : json(this.listTasks(url.searchParams.get("roomId") ?? ""));
    if (req.method === "GET" && (m = path.match(/^\/api\/tasks\/([^/]+)$/))) {
      const t = this.tasks.get(decodeURIComponent(m[1]));
      return t ? json(t) : json({ error: "not_found" }, 404);
    }
    // Round q1, I: a new task, as the office files it (201 and the task).
    if (req.method === "POST" && path === "/api/tasks") {
      if (this.noOwner) return forbidden();
      if (this.taskFail === "hang") return new Promise<Response>(() => {});
      if (this.taskFail) return json({ error: { code: "task_fail", message: "Failed by the fake office." } }, this.taskFail);
      const b = (await body()) as { title?: string; description?: string; roomId?: string };
      return json(this.addTask({ title: String(b.title ?? ""), description: String(b.description ?? ""), roomId: String(b.roomId ?? ""), createdBy: "Antifeed" }), 201);
    }
    // As the office: an app message to an agent it cannot reach is 404 recipient_not_found.
    if (req.method === "POST" && path === "/api/app/message") {
      if (this.noOwner) return forbidden();
      if (this.sendFail === "hang") return new Promise<Response>(() => {});
      if (this.sendFail) return json({ error: { code: "send_fail", message: "Failed by the fake office." } }, this.sendFail);
      const b = (await body()) as { text?: string; targetAgentId?: string };
      if (!this.roster.some((a) => a.id === b.targetAgentId)) return json({ error: { code: "recipient_not_found", message: "No such agent." } }, 404);
      this.messages.push({ text: String(b.text ?? ""), to: String(b.targetAgentId), at: this.now() });
      return json({ ok: true });
    }
    // Control: the reviewer plays the agents and the Inbox.
    if (path.startsWith("/control/")) {
      const b = (req.method === "POST" ? await body() : {}) as Record<string, any>;
      const ok = (v: unknown) => json(v ?? { ok: true });
      switch (`${req.method} ${path}`) {
        case "GET /control/state":
          return json({ asks: [...this.asks.values()], pages: [...this.pages.values()], answers: this.answers, acks: this.acks, switchOff: this.switchOff, noOwner: this.noOwner, sendFail: this.sendFail, taskFail: this.taskFail, busy: [...this.busy], tasks: [...this.tasks.values()], messages: this.messages, roster: this.roster });
        // Slice 8: Wall Game's board and its PM.
        case "POST /control/boardfail":
          this.boardFail = b.on === true;
          return ok({ boardFail: this.boardFail });
        case "POST /control/sendfail":
          this.sendFail = [403, 404, 502, "hang"].includes(b.mode) ? b.mode : null;
          return ok({ sendFail: this.sendFail });
        case "POST /control/taskfail":
          this.taskFail = [403, 422, 502, "hang"].includes(b.mode) ? b.mode : null;
          return ok({ taskFail: this.taskFail });
        case "POST /control/task":
          return ok(this.addTask({ ...b, title: String(b.title ?? ""), roomId: String(b.roomId ?? "51c2d889") }));
        case "POST /control/task/edit":
          return ok(this.editTask(String(b.id), b.patch ?? {}) ?? json({ error: "not_found" }, 404));
        case "POST /control/roster/remove":
          this.roster = this.roster.filter((a) => a.name !== b.name);
          return ok(null);
        // As the office (isomux server/asks.ts): 2 to 4 options, or none.
        case "POST /control/ask":
          if (Array.isArray(b.options) && (b.options.length < 2 || b.options.length > 4)) return json({ error: { code: "bad_request", message: "give 2 to 4 options" } }, 400);
          return ok(this.addAsk(b as Ask, (b.files ?? []).map((f: { name: string; type: string; base64: string }) => ({ name: f.name, type: f.type, bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) }))));
        case "POST /control/ask/edit":
          return ok(this.editAsk(String(b.id), b.patch ?? {}) ?? json({ error: "not_found" }, 404));
        case "POST /control/ask/close":
          return this.closeAsk(String(b.id)) ? ok(null) : json({ error: "not_found" }, 404);
        case "POST /control/page":
          return ok(this.raisePage(b as { title: string }));
        case "POST /control/page/state":
          return this.setPage(String(b.id), b.state === "resolved" ? "resolved" : "acked") ? ok(null) : json({ error: "not_found" }, 404);
        // {switch: false}: Nil's Inbox access is off. {owner: false}: no live owner agent.
        case "POST /control/reach":
          if (typeof b.switch === "boolean") this.switchOff = !b.switch;
          if (typeof b.owner === "boolean") this.noOwner = !b.owner;
          return ok(null);
        case "POST /control/ask/busy":
          if (b.on === false) this.busy.delete(String(b.id));
          else this.busy.add(String(b.id));
          return ok(null);
      }
    }
    return json({ error: "not_found" }, 404);
  }
}
