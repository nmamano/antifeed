// The Inbox source (DESIGN.md 14.1): reads Nil's open asks and open pages
// from the office and emits inbox.* events through the engine's source
// route. Its state is the projection of its logged events, so a restart
// diffs against the log. It drops every secret request before it emits
// anything. It reads only; the inbox project's office actor answers.

import type { Blobs } from "./blobs";
import { NIL_MEMBER_ID, OFFICE_URL } from "./config";
import type { Engine } from "./engine";
import { type Agent, type Ask, NO_NIL_TOKEN, type Office, type Page, TOKEN_REFUSED, tokenError } from "./office";

// What an ask's event carries: the ask as the policy needs it, the names the
// office gave, and the ask's files as blobs (or why a file did not load).
export type AskFile = { name: string; mediaType: string; size?: number; blob?: string; error?: string };
export type AskData = {
  prompt: string;
  agentId: string;
  agentName: string;
  roomName: string;
  createdAt: number;
  updatedAt: number;
  link?: string;
  options?: string[];
  recommended?: string;
  commands?: string[];
  editFiles: number;
  files: AskFile[];
};
export type PageData = {
  title: string;
  body?: string;
  sourceName: string;
  roomName: string;
  agentId?: string;
  createdAt: number;
  lastRaisedAt: number;
  raiseCount: number;
  // inbox.page.closed: acked, resolved, or gone.
  state?: string;
};
// other: asks and pages for another member, dropped. asksOff: why the
// asks did not come in (the pages still did).
export type InboxReport = { asks: number; pages: number; opened: number; changed: number; closed: number; secret: number; other: number; errors: string[]; asksOff?: string };

// Why the office refuses a read (isomux task 4a1e58c9). The office answers
// each case with the same 403, so the source tells them apart with GET
// /agents: it works while the app has a live owner agent. Pages need no switch.
// The words name no switch and give Nil no step: he ruled against an
// asks-only switch for apps (2026-10-28; isomux task 4dce5b39 removes it).
export const ACCESS_OFF = "the office did not let Antifeed answer this ask";
export const OWNERLESS = "the app has no live owner agent (give it one on the Apps page in the office)";
// Part N: without Nil's API token the asks do not come in (a state, shown on Sources).
export const ASKS_OFF = NO_NIL_TOKEN;
export const NO_OWNER = `the office refuses this app's reads: ${OWNERLESS}`;
export const refused = (err: unknown) => /\b403\b/.test((err as Error).message);

// The largest file the blob store keeps (TYPES): a bigger one is not read.
export const FILE_MAX = 20 * 2 ** 20;

// An ask's link is a path on the office ("/agents/x"). Anything else (a full
// URL, "//host", "@host") could take Nil to another site under the office's
// name, so it is dropped.
export function officePath(link: unknown): string | null {
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//") || /[\\\s]/.test(link)) return null;
  try {
    return new URL(OFFICE_URL + link).origin === new URL(OFFICE_URL).origin ? link : null;
  } catch {
    return null;
  }
}

const IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export class InboxSource {
  private roster: Agent[] = [];
  constructor(
    private engine: Engine,
    private office: Office,
    private blobs: Blobs,
    readonly project: string,
    readonly source: string,
  ) {}

  // What the log says is open: the last inbox event per ask and per page.
  known(): { asks: Map<string, { updatedAt: number; closed: boolean }>; pages: Map<string, { title: string; body: string; raiseCount: number; closed: boolean }> } {
    const by = `code:source/${this.source}`;
    const asks = new Map<string, { updatedAt: number; closed: boolean }>();
    const pages = new Map<string, { title: string; body: string; raiseCount: number; closed: boolean }>();
    for (const e of this.engine.log.all()) {
      if (e.project !== this.project || e.by !== by) continue;
      if (e.type.startsWith("inbox.ask.")) asks.set(e.subject!, { updatedAt: e.data?.updatedAt ?? 0, closed: e.type === "inbox.ask.closed" });
      if (e.type.startsWith("inbox.page.")) pages.set(e.subject!, { title: e.data?.title ?? "", body: e.data?.body ?? "", raiseCount: e.data?.raiseCount ?? 0, closed: e.type === "inbox.page.closed" });
    }
    return { asks, pages };
  }

  private emit(type: string, id: string, data: object, key: string): void {
    this.engine.sourceEvent({ project: this.project, source: this.source, type, subject: id, data, key: `${type}|${id}|${key}` });
  }

  private agent(id: string | undefined): Agent | undefined {
    return id ? this.roster.find((a) => a.id === id) : undefined;
  }

  private roomName(roomId: string | undefined): string {
    return (roomId && this.roster.find((a) => a.roomId === roomId)?.roomName) || "";
  }

  // The ask's files, through the office, into blobs. A file that does not
  // load says why; the card shows it so, and the Inbox still has it.
  private async files(a: Ask): Promise<AskFile[]> {
    const out: AskFile[] = [];
    for (const f of a.readFiles ?? []) {
      const name = f.originalName || f.filename;
      const mediaType = f.mediaType || "application/octet-stream";
      if ((f.size ?? 0) > FILE_MAX) {
        out.push({ name, mediaType, size: f.size, error: `over the ${FILE_MAX / 2 ** 20} MB that Antifeed keeps` });
        continue;
      }
      try {
        const got = await this.office.file(a.agentId, f.filename, FILE_MAX);
        if (!got) {
          out.push({ name, mediaType, size: f.size, error: "the office has no such file" });
          continue;
        }
        const type = got.type.split(";")[0].trim();
        const kept = IMAGE.includes(type) || type === "application/pdf" || type === "text/plain" ? type : "application/octet-stream";
        const r = this.blobs.put(kept, got.bytes);
        out.push("error" in r ? { name, mediaType, size: f.size, error: r.error } : { name, mediaType: type, size: got.bytes.length, blob: r.name });
      } catch (err) {
        out.push({ name, mediaType, size: f.size, error: (err as Error).message });
      }
    }
    return out;
  }

  private async askData(a: Ask): Promise<AskData> {
    const who = this.agent(a.agentId);
    return {
      prompt: a.prompt,
      agentId: a.agentId,
      agentName: who?.name ?? a.agentId,
      roomName: who?.roomName ?? "",
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      ...(officePath(a.link) ? { link: a.link } : {}),
      ...(a.options?.length ? { options: a.options } : {}),
      ...(a.recommended ? { recommended: a.recommended } : {}),
      ...(a.commands?.length ? { commands: a.commands } : {}),
      editFiles: Array.isArray(a.editFiles) ? a.editFiles.length : 0,
      files: await this.files(a),
    };
  }

  private pageData(p: Page): PageData {
    const s = p.source;
    const sourceName = s.kind === "agent" ? s.name : `the app ${String(s.appName)}`;
    const roomName = s.kind === "agent" ? this.roomName(s.roomId) : "";
    return {
      title: p.title,
      ...(p.body ? { body: p.body } : {}),
      sourceName,
      roomName,
      ...(s.kind === "agent" ? { agentId: s.agentId } : {}),
      createdAt: p.createdAt,
      lastRaisedAt: p.lastRaisedAt,
      raiseCount: p.raiseCount,
    };
  }

  async poll(): Promise<InboxReport> {
    const out: InboxReport = { asks: 0, pages: 0, opened: 0, changed: 0, closed: 0, secret: 0, other: 0, errors: [] };
    try {
      this.roster = await this.office.agents();
    } catch (err) {
      if (refused(err)) throw new Error(NO_OWNER);
      out.errors.push(`agents: ${(err as Error).message}`);
    }
    // A refused read opens and closes nothing: the log keeps what it knew.
    let pages: Page[];
    try {
      pages = await this.office.pages();
    } catch (err) {
      throw new Error(refused(err) ? NO_OWNER : (err as Error).message);
    }
    let asks: Ask[] | null = null;
    try {
      asks = await this.office.asks();
    } catch (err) {
      // Part N: no token is a state; a refused token, or a refusal, names the token.
      out.asksOff = tokenError(err) ? (err as Error).message : refused(err) ? TOKEN_REFUSED : `the asks did not load: ${(err as Error).message}`;
    }
    const known = this.known();

    // Asks. A secret request never comes in (DESIGN.md 14.1), and nor does
    // an ask for another member: Nil would answer it as himself.
    const listed = new Set<string>();
    for (const a of asks ?? []) {
      if (a.secret) {
        out.secret++;
        continue;
      }
      if (a.memberUserId && a.memberUserId !== NIL_MEMBER_ID) {
        out.other++;
        continue;
      }
      out.asks++;
      listed.add(a.id);
      const k = known.asks.get(a.id);
      if (!k || k.closed) {
        this.emit("inbox.ask.opened", a.id, await this.askData(a), String(a.updatedAt));
        out.opened++;
      } else if (k.updatedAt !== a.updatedAt) {
        this.emit("inbox.ask.changed", a.id, await this.askData(a), String(a.updatedAt));
        out.changed++;
      }
    }
    if (asks)
      for (const [id, k] of known.asks) {
        if (k.closed || listed.has(id)) continue;
        this.emit("inbox.ask.closed", id, { updatedAt: k.updatedAt }, String(k.updatedAt));
        out.closed++;
      }

    // Pages: the open ones. A raise with new words, or the same words with a
    // new count, is a change: the policy tells them apart.
    const open = new Set<string>();
    for (const p of pages) {
      if (p.state !== "open") continue;
      // The office lists every page in Nil's rooms: only his come in.
      if (p.targetUserId !== NIL_MEMBER_ID) {
        out.other++;
        continue;
      }
      out.pages++;
      open.add(p.id);
      const k = known.pages.get(p.id);
      const d = this.pageData(p);
      if (!k || k.closed) {
        this.emit("inbox.page.opened", p.id, d, String(p.lastRaisedAt));
        out.opened++;
      } else if (k.title !== p.title || k.body !== (p.body ?? "") || k.raiseCount !== p.raiseCount) {
        this.emit("inbox.page.changed", p.id, d, String(p.lastRaisedAt));
        out.changed++;
      }
    }
    for (const [id, k] of known.pages) {
      if (k.closed || open.has(id)) continue;
      // Not open any more: read it to know why.
      let state = "gone";
      try {
        state = (await this.office.page(id))?.state ?? "gone";
      } catch (err) {
        out.errors.push(`page ${id}: ${(err as Error).message}`);
        continue;
      }
      if (state === "open") continue;
      this.emit("inbox.page.closed", id, { title: k.title, body: k.body, state }, state);
      out.closed++;
    }
    return out;
  }
}
