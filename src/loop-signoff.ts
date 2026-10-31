// The Loop app's sign-off source (Part J, Nil's go 2026-10-30): reads the
// Loop app's Sign-off list and emits signoff.item.* through the engine's
// source route, as the board source reads the board. An item that waits for
// Nil (merged, not decided) is a subject; its merged commit is its version.
// Its images are copied into Antifeed's blobs here, so no agent uploads them.
// Its state is the projection of the logged signoff.item.* events, so a
// restart diffs against the log. Read only: it never writes the Loop app.

import type { Blobs } from "./blobs";
import type { Engine } from "./engine";
import type { SignoffCopy, SignoffImage } from "./types";

// What GET /api/signoff gives per item (the fields this source reads).
type LoopImage = { file: string; caption: string; type: string; pair?: string; side?: "before" | "after" };
type LoopItem = {
  taskId: string;
  title: string;
  summary?: string;
  copy?: { where: string; old: string; new: string; audience?: "member" | "agent" }[];
  images?: LoopImage[];
  merged: { commit: string; at: number } | null;
  state: string;
};
// A merge not pushed yet; sent: it was in the last push go (the Loop app's unpushed list).
type Unpushed = { taskId: string; commit: string; sent?: boolean };
export type SignoffItemData = { taskId: string; title: string; summary: string; commit: string; mergedAt: number | null; copy: SignoffCopy[]; images: SignoffImage[]; sig: string };
export type LoopPollReport = { waiting: number; left: number; errors: string[] };

export class LoopSignoffSource {
  constructor(
    private engine: Engine,
    private blobs: Blobs,
    readonly project: string,
    readonly source: string,
    readonly url: string,
    private get: (url: string) => Promise<Response> = (u) => fetch(u, { signal: AbortSignal.timeout(15_000) }),
  ) {}

  // What the log says each item is: the last signoff.item.* event per task.
  // type: waiting or left (a push go only marks the item); pushgo: a push go took its approval.
  known(): Map<string, { type: string; commit: string; sig: string; state: string; pushgo: boolean; n: number }> {
    const by = `code:source/${this.source}`;
    const out = new Map<string, { type: string; commit: string; sig: string; state: string; pushgo: boolean; n: number }>();
    for (const e of this.engine.log.all()) {
      if (e.project !== this.project || e.by !== by || !e.type.startsWith("signoff.item.")) continue;
      const prev = out.get(e.subject!);
      const n = (prev?.n ?? 0) + 1;
      if (e.type === "signoff.item.pushgo") {
        if (prev) out.set(e.subject!, { ...prev, pushgo: true, n });
        continue;
      }
      out.set(e.subject!, { type: e.type, commit: e.data?.commit ?? "", sig: e.data?.sig ?? "", state: e.data?.state ?? "waiting", pushgo: false, n });
    }
    return out;
  }

  async poll(): Promise<LoopPollReport> {
    const out: LoopPollReport = { waiting: 0, left: 0, errors: [] };
    const r = await this.get(`${this.url}/api/signoff`);
    if (!r.ok) throw new Error(`GET /api/signoff answered ${r.status}`);
    const body = (await r.json()) as { items?: LoopItem[]; unpushed?: Unpushed[] };
    const items = body.items ?? [];
    // Reviewer B3: an approved item stays on the list after the push; it is pushed (or in a push go) when its
    // task is not in unpushed, or its unpushed entry was in the last push go. By task id, so a re-merge does not hide it.
    const unpushed = new Map((body.unpushed ?? []).map((u) => [u.taskId, u]));
    const pushed = (id: string) => !unpushed.has(id) || !!unpushed.get(id)!.sent;
    const known = this.known();
    const listed = new Map(items.map((i) => [i.taskId, i]));
    // n: how many events this task had, so a repeated state (waiting again after an Undo) is a new key.
    const emit = (type: string, id: string, data: object) => this.engine.sourceEvent({ project: this.project, source: this.source, type, subject: id, data, key: `${type}|${id}|${known.get(id)?.n ?? 0}` });
    for (const i of items) {
      if (i.state !== "waiting" || !i.merged) continue;
      const k = known.get(i.taskId);
      const sig = JSON.stringify([i.title, i.summary ?? "", i.copy ?? [], (i.images ?? []).map((m) => [m.file, m.caption, m.pair, m.side])]);
      if (k && k.type === "signoff.item.waiting" && k.commit === i.merged.commit && k.sig === sig) continue;
      try {
        emit("signoff.item.waiting", i.taskId, await this.data(i, sig));
        out.waiting++;
      } catch (err) {
        out.errors.push(`${i.taskId}: ${(err as Error).message}`);
      }
    }
    // An item that left "waiting" by another path: decided (on the Loop app's tab, or by Antifeed's own call), reverted, pushed.
    for (const [id, k] of known) {
      if (k.type !== "signoff.item.waiting") continue;
      const now = listed.get(id);
      // Still waiting (a re-merge is a waiting event with its new commit, above).
      if (now && now.state === "waiting" && now.merged) continue;
      emit("signoff.item.left", id, { commit: k.commit, state: now ? now.state : "gone", ...(now?.merged ? { now: now.merged.commit } : {}) });
      out.left++;
    }
    // An approval stays undoable until the item leaves the list (the push took it).
    for (const [id, k] of known)
      if (k.type === "signoff.item.left" && k.state !== "gone" && !listed.has(id)) {
        emit("signoff.item.left", id, { commit: k.commit, state: "gone" });
        out.left++;
      } else if (k.type === "signoff.item.left" && k.state === "approved" && !k.pushgo && listed.get(id)?.state === "approved" && pushed(id)) {
        // A push go took the approval (the item stays "approved" on the Loop app, also after the push): its Undo is over.
        emit("signoff.item.pushgo", id, { commit: k.commit });
      }
    return out;
  }

  // The item's data, its images copied into blobs (English copy only).
  private async data(i: LoopItem, sig: string): Promise<SignoffItemData> {
    const images: SignoffImage[] = [];
    for (const m of i.images ?? []) {
      const r = await this.get(`${this.url}/img/signoff/${encodeURIComponent(i.taskId)}/${encodeURIComponent(m.file)}`);
      if (!r.ok) throw new Error(`image ${m.file} answered ${r.status}`);
      const put = this.blobs.put(r.headers.get("content-type") ?? m.type, new Uint8Array(await r.arrayBuffer()));
      if ("error" in put) throw new Error(`image ${m.file}: ${put.error}`);
      images.push({ blob: put.name, caption: m.caption ?? "", ...(m.pair ? { pair: m.pair } : {}), ...(m.side ? { side: m.side } : {}) });
    }
    // English only (Nil, 2026-10-19) holds as on the Loop app: a worker posts English copy only.
    const copy: SignoffCopy[] = (i.copy ?? []).map((c) => ({ where: c.where, old: c.old, new: c.new, audience: c.audience === "agent" ? "agent" : "member" }));
    return { taskId: i.taskId, title: i.title, summary: i.summary ?? "", commit: i.merged!.commit, mergedAt: i.merged!.at ?? null, copy, images, sig };
  }
}
