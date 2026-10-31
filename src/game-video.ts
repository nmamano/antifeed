// The game-video app's review queue (Wall Game; Nil, 2026-10-30: "i want the
// video reviews for wall game to show up here as a new kind"): reads Nil's
// review queue and emits video.item.* through the engine's source route, as
// the Loop app's sign-off source does. Each item in review is a subject; its
// video is copied into Antifeed's blobs here (again only when its
// videoSha256 changes). Its state is the projection of the logged
// video.item.* events, so a restart diffs against the log. Read only: it
// never presses the app's routes (projects/wallgame/video.ts does, on Nil's call).

import type { Blobs } from "./blobs";
import type { Engine } from "./engine";

// What GET /api/review/queue gives per item in review (game-video daily/review.mjs).
export type QueueItem = {
  id: string;
  videoSha256: string;
  copySha256: string;
  caption: string;
  youtubeTitle?: string | null;
  approveProblem?: string | null;
  claimRiskSounds?: string[];
  noStory?: string | null;
  version?: unknown;
  scriptCarried?: string | null;
};
export type VideoItemData = {
  id: string;
  videoSha256: string;
  copySha256: string;
  caption: string;
  youtubeTitle: string | null;
  approveProblem: string | null;
  claimRiskSounds: string[];
  noStory: string | null;
  version: string | null;
  scriptCarried: string | null;
  blob: string;
  sig: string;
};
type Known = { type: string; sig: string; videoSha256: string; blob: string; n: number; notSent: boolean };
export type VideoPollReport = { waiting: number; left: number; errors: string[] };

// Only Nil reviews: the app takes his member id in this header (the office
// sets it for his page; a process on this box may set it, review.mjs says so),
// and his name in the next one, URI-encoded as the office does, so the page and
// its feedback log say "Nil", not the id (Antifeed Reviewer's m1 on 95fc872).
export type VideoMember = { id: string; name: string };
export const memberHeader = (m: VideoMember) => ({ "X-Isomux-Member-Id": m.id, "X-Isomux-Member-Name": encodeURIComponent(m.name) });
// A video copy that failed (a 404, a timeout, over the blob limit) is tried
// again only after this time, not on every read (Antifeed Reviewer's m2).
export const COPY_RETRY_MS = 10 * 60_000;

export class GameVideoSource {
  constructor(
    private engine: Engine,
    private blobs: Blobs,
    readonly project: string,
    readonly source: string,
    readonly url: string,
    readonly member: VideoMember,
    private get: (url: string, headers: Record<string, string>) => Promise<Response> = (u, h) => fetch(u, { headers: h, signal: AbortSignal.timeout(120_000) }),
    private now: () => number = Date.now,
  ) {}
  // id and videoSha256 -> when its copy failed and why
  private copyFailed = new Map<string, { at: number; error: string }>();

  // What the log says each item is: its last video.item.* event, and whether
  // a call on it came back not sent after that event (notSent).
  known(): Map<string, Known> {
    const by = `code:source/${this.source}`;
    const out = new Map<string, Known>();
    for (const e of this.engine.log.all()) {
      if (e.project !== this.project) continue;
      if (e.type === "command.done" && (e.data?.result as { notSent?: unknown } | undefined)?.notSent) {
        const k = this.engine.commands.get(e.command!);
        const prev = k?.type === "video.apply" && k.subject ? out.get(k.subject) : undefined;
        if (prev) prev.notSent = true;
        continue;
      }
      if (e.by !== by || !e.type.startsWith("video.item.")) continue;
      const prev = out.get(e.subject!);
      const n = (prev?.n ?? 0) + 1;
      if (e.type === "video.item.left") out.set(e.subject!, { type: e.type, sig: "", videoSha256: prev?.videoSha256 ?? "", blob: prev?.blob ?? "", n, notSent: false });
      else out.set(e.subject!, { type: e.type, sig: e.data?.sig ?? "", videoSha256: e.data?.videoSha256 ?? "", blob: e.data?.blob ?? "", n, notSent: false });
    }
    return out;
  }

  async poll(): Promise<VideoPollReport> {
    const out: VideoPollReport = { waiting: 0, left: 0, errors: [] };
    const r = await this.get(`${this.url}/api/review/queue`, memberHeader(this.member));
    if (!r.ok) throw new Error(`GET /api/review/queue answered ${r.status}`);
    const items = ((await r.json()) as { items?: QueueItem[] }).items ?? [];
    const known = this.known();
    const listed = new Set(items.map((i) => i.id));
    const emit = (type: string, id: string, data: object) => this.engine.sourceEvent({ project: this.project, source: this.source, type, subject: id, data, key: `${type}|${id}|${known.get(id)?.n ?? 0}` });
    for (const i of items) {
      if (!i?.id || !i.videoSha256) continue;
      const k = known.get(i.id);
      const sig = JSON.stringify([i.videoSha256, i.copySha256, i.caption, i.youtubeTitle ?? null, i.approveProblem ?? null, i.claimRiskSounds ?? [], i.noStory ?? null, i.version ?? null, i.scriptCarried ?? null]);
      // Unchanged since the last read: nothing new. But a call that came back
      // not sent (the video read changed right before the press) and the
      // video as Nil saw it again: a new card shows it (Antifeed Reviewer's n1).
      if (k && k.type === "video.item.waiting" && k.sig === sig && !k.notSent) continue;
      const failKey = `${i.id}|${i.videoSha256}`;
      const failed = this.copyFailed.get(failKey);
      if (failed && this.now() - failed.at < COPY_RETRY_MS) {
        out.errors.push(`${i.id}: ${failed.error} (tried again ${Math.round(COPY_RETRY_MS / 60_000)} min after the failure)`);
        continue;
      }
      try {
        // The video again only for a new render.
        const blob = k?.blob && k.videoSha256 === i.videoSha256 ? k.blob : await this.video(i.id);
        this.copyFailed.delete(failKey);
        emit("video.item.waiting", i.id, this.data(i, blob, sig));
        out.waiting++;
      } catch (err) {
        this.copyFailed.set(failKey, { at: this.now(), error: (err as Error).message });
        out.errors.push(`${i.id}: ${(err as Error).message}`);
      }
    }
    // An item that left the queue: approved, revised or discarded (on the page or by Antifeed), or gone.
    for (const [id, k] of known) {
      if (k.type !== "video.item.waiting" || listed.has(id)) continue;
      emit("video.item.left", id, {});
      out.left++;
    }
    return out;
  }

  private async video(id: string): Promise<string> {
    const r = await this.get(`${this.url}/api/daily/video?item=${encodeURIComponent(id)}`, memberHeader(this.member));
    if (!r.ok) throw new Error(`the video answered ${r.status}`);
    const put = this.blobs.put(r.headers.get("content-type") ?? "video/mp4", new Uint8Array(await r.arrayBuffer()));
    if ("error" in put) throw new Error(`the video: ${put.error}`);
    return put.name;
  }

  private data(i: QueueItem, blob: string, sig: string): VideoItemData {
    const line = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    return {
      id: i.id, videoSha256: i.videoSha256, copySha256: i.copySha256, caption: i.caption ?? "",
      youtubeTitle: line(i.youtubeTitle), approveProblem: line(i.approveProblem),
      claimRiskSounds: (i.claimRiskSounds ?? []).filter((x) => typeof x === "string"),
      noStory: line(i.noStory), version: i.version == null ? null : String(i.version), scriptCarried: line(i.scriptCarried),
      blob, sig,
    };
  }
}
