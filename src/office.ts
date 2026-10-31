// The office API as the app token reaches it: the board (read only in
// Antifeed until a decision kind moves), the agent list, and messages.

export const OFFICE = "http://localhost:4000";

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string | null;
  assignee?: string | null;
  createdBy?: string;
  createdAt: number;
  roomId?: string;
  version: string;
};

// An ask of Nil's, as GET /api/asks answers (isomux shared/types.ts
// AskEntry without sessionId, read 2026-10-26). Secret requests never reach
// Antifeed: the source drops them.
export type Attachment = { filename: string; originalName?: string; mediaType?: string; size?: number };
export type Ask = {
  id: string;
  agentId: string;
  memberUserId?: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  link?: string;
  options?: string[];
  recommended?: string;
  commands?: string[];
  editFiles?: unknown[];
  readFiles?: Attachment[];
  secret?: unknown;
};
// A page for Nil, as GET /api/pager answers (PagerEntry, read 2026-10-26).
export type Page = {
  id: string;
  createdAt: number;
  lastRaisedAt: number;
  raiseCount: number;
  source: { kind: "agent"; agentId: string; name: string; roomId: string } | { kind: "app"; appName: string; [k: string]: unknown };
  targetUserId: string;
  title: string;
  body?: string;
  key?: string;
  state: "open" | "acked" | "resolved";
};
// How the office answered a write: ok, the ask or page is gone (404), or
// another answer to the ask is going out now (409 ask_busy).
export type WriteResult = "ok" | "gone" | "busy";

export type Agent = { id: string; name: string; roomId?: string; roomName?: string; backRoom?: boolean; model?: string; effort?: string; inFlightTurn?: unknown };

export interface Office {
  // Open and in-progress P0-P3 tasks of a room (the board's default listing).
  tasks(roomId: string): Promise<Task[]>;
  // One task, any status; null when it is gone.
  task(id: string): Promise<Task | null>;
  agents(): Promise<Agent[]>;
  // Throws when the office does not take the message.
  message(text: string, targetAgentId: string): Promise<void>;
  // Round q1, I: a new task on a room's board, with no priority. Throws when
  // the office does not take it ("answered <status>" in the error).
  createTask(t: { title: string; description: string; roomId: string }): Promise<{ id: string }>;
  // Slice 7, Nil's Inbox (isomux task 4a1e58c9): his open asks and open
  // pages, the answers, and an ask's files. A refused read throws.
  asks(): Promise<Ask[]>;
  answerAsk(id: string, how: "reply" | "dismiss" | "file-task", text: string): Promise<WriteResult>;
  pages(): Promise<Page[]>;
  // One page in any state; null when it is gone.
  page(id: string): Promise<Page | null>;
  ackPage(id: string): Promise<WriteResult>;
  // A file over max bytes is not read to its end: it throws.
  file(agentId: string, filename: string, max: number): Promise<{ type: string; bytes: Uint8Array } | null>;
}

// A message the office does not answer in sendMs fails: an at-most-once
// sender reads that as "may have gone" (slice 8, Antifeed Reviewer's minor).
export const SEND_MS = 30_000;

// Part N (Nil's ruling, isomux task 4dce5b39: apps get no asks permission):
// Nil's own API token, which he gives the app through a secret request. The
// app gets it in its environment under this name. With it, his Inbox (asks,
// their files, pages) is read and answered as him. Never logged or printed.
export const NIL_TOKEN = "ANTIFEED_NIL_TOKEN";
// Without the token the asks are not read (a state, not a failure).
export const NO_NIL_TOKEN = "asks need your API token: see the secret request in your Inbox";
// A 401 or 403 with the token: it is wrong or revoked. It names the token.
export const TOKEN_REFUSED = `the office refused your API token (${NIL_TOKEN}): make a new one on the API tokens page and give it to the antifeed app on the Integrations page`;
export const tokenError = (err: unknown) => [NO_NIL_TOKEN, TOKEN_REFUSED].includes((err as Error).message);

// A refused token is not tried again for this long, or until a restart
// (Antifeed Reviewer's m2: no known-bad token of Nil's every 10 s).
export const REFUSED_RETRY_MS = 10 * 60_000;

export function httpOffice(token: string, base = OFFICE, sendMs = SEND_MS, nilToken: string | null = null, now: () => number = Date.now): Office {
  const auth = { Authorization: `Bearer ${token}` };
  const nil = nilToken ? { Authorization: `Bearer ${nilToken}` } : null;
  let refusedAt: number | null = null;
  const nilOk = () => !!nil && (refusedAt === null || now() - refusedAt >= REFUSED_RETRY_MS);
  const needNil = () => {
    if (!nil) throw new Error(NO_NIL_TOKEN);
    if (!nilOk()) throw new Error(TOKEN_REFUSED);
    return nil;
  };
  const check = (h: Record<string, string>, status: number) => {
    if (h !== nil) return;
    if (status === 401 || status === 403) {
      refusedAt = now();
      throw new Error(TOKEN_REFUSED);
    }
    refusedAt = null;
  };
  // The pages: as Nil with his token; with no token, or one the office
  // refused, with the app token as before (Antifeed Reviewer's m1).
  async function pager<T>(f: (h: Record<string, string>) => Promise<T>): Promise<T> {
    const h = nilOk() ? nil! : auth;
    try {
      return await f(h);
    } catch (err) {
      if (h === nil && (err as Error).message === TOKEN_REFUSED) return f(auth);
      throw err;
    }
  }
  async function getJson<T>(path: string, h: Record<string, string> = auth): Promise<{ status: number; body: T | null }> {
    const res = await fetch(`${base}${path}`, { headers: h });
    if (res.status === 404) return { status: 404, body: null };
    check(h, res.status);
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} answered ${res.status}`);
    return { status: res.status, body: (await res.json()) as T };
  }
  return {
    tasks: async (roomId) => (await getJson<Task[]>(`/api/tasks?roomId=${encodeURIComponent(roomId)}`)).body ?? [],
    task: async (id) => (await getJson<Task>(`/api/tasks/${encodeURIComponent(id)}`)).body,
    async agents() {
      const list = (await getJson<Agent[] | { agents: Agent[] }>("/agents?back=1")).body;
      return Array.isArray(list) ? list : (list?.agents ?? []);
    },
    asks: async () => (await getJson<Ask[]>("/api/asks", needNil())).body ?? [],
    async answerAsk(id, how, text) {
      // A dismiss or a filed task with no words sends no text: the agent reads the office's own words.
      const body = how === "reply" || text.trim() ? { text } : {};
      const h = needNil();
      const res = await fetch(`${base}/api/asks/${encodeURIComponent(id)}/${how}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      check(h, res.status);
      if (res.status === 404) return "gone";
      if (res.status === 409) return "busy";
      if (!res.ok) throw new Error(`POST /api/asks/:id/${how} answered ${res.status}`);
      return "ok";
    },
    pages: () => pager(async (h) => (await getJson<Page[]>("/api/pager?state=open", h)).body ?? []),
    page: (id) => pager(async (h) => (await getJson<Page>(`/api/pager/${encodeURIComponent(id)}`, h)).body),
    ackPage: (id) => pager(async (h) => {
      const res = await fetch(`${base}/api/pager/${encodeURIComponent(id)}/ack`, { method: "POST", headers: h });
      check(h, res.status);
      // 404: gone; 409: resolved meanwhile. Either way nothing is left to ack.
      if (res.status === 404 || res.status === 409) return "gone";
      if (!res.ok) throw new Error(`POST /api/pager/:id/ack answered ${res.status}`);
      return "ok" as const;
    }),
    async file(agentId, filename, max) {
      const h = needNil();
      const res = await fetch(`${base}/api/files/${encodeURIComponent(agentId)}/${encodeURIComponent(filename)}`, { headers: h });
      if (res.status === 404) return null;
      check(h, res.status);
      if (!res.ok) throw new Error(`GET /api/files answered ${res.status}`);
      const tooBig = () => new Error(`over the ${max / 2 ** 20} MB that Antifeed keeps`);
      if (Number(res.headers.get("content-length") ?? 0) > max) {
        await res.body?.cancel();
        throw tooBig();
      }
      // Read in parts, and stop at the cap: the length header may be absent.
      const parts: Uint8Array[] = [];
      let n = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > max) {
          await reader.cancel();
          throw tooBig();
        }
        parts.push(value);
      }
      const bytes = new Uint8Array(n);
      let at = 0;
      for (const v of parts) {
        bytes.set(v, at);
        at += v.length;
      }
      return { type: res.headers.get("content-type") ?? "application/octet-stream", bytes };
    },
    async message(text, targetAgentId) {
      const res = await fetch(`${base}/api/app/message`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, targetAgentId }),
        signal: AbortSignal.timeout(sendMs),
      });
      if (!res.ok) throw new Error(`POST /api/app/message answered ${res.status}`);
    },
    async createTask(t) {
      const res = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(t),
        signal: AbortSignal.timeout(sendMs),
      });
      if (!res.ok) throw new Error(`POST /api/tasks answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id !== "string") throw new Error("POST /api/tasks answered with no task id");
      return { id: body.id };
    },
  };
}

// For tests and for a data dir copied away from the office: it reads
// nothing and sends nothing.
export const nullOffice: Office = {
  tasks: async () => [],
  task: async () => null,
  agents: async () => [],
  message: async () => {
    throw new Error("this office cannot send");
  },
  createTask: async () => {
    throw new Error("this office cannot send");
  },
  asks: async () => [],
  answerAsk: async () => {
    throw new Error("this office cannot send");
  },
  pages: async () => [],
  page: async () => null,
  ackPage: async () => {
    throw new Error("this office cannot send");
  },
  file: async () => null,
};
