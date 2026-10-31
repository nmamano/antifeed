// Content-addressed blobs (DESIGN.md section 3): blobs/<sha256>.<ext>. The
// read answers HTTP Range requests (206): WebKit needs them to play video.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TYPES: Record<string, { ext: string; max: number }> = {
  "image/png": { ext: "png", max: 10 * 2 ** 20 },
  "image/jpeg": { ext: "jpg", max: 10 * 2 ** 20 },
  "image/webp": { ext: "webp", max: 10 * 2 ** 20 },
  "image/gif": { ext: "gif", max: 10 * 2 ** 20 },
  "video/mp4": { ext: "mp4", max: 200 * 2 ** 20 },
  "video/webm": { ext: "webm", max: 200 * 2 ** 20 },
  // The consult agent's inputs and raw answers (DESIGN.md 13.1).
  "text/plain": { ext: "txt", max: 2 * 2 ** 20 },
  // Slice 7: an ask's files, as the Inbox shows them. A type not listed here is kept as bytes.
  "application/pdf": { ext: "pdf", max: 20 * 2 ** 20 },
  "application/octet-stream": { ext: "bin", max: 20 * 2 ** 20 },
};
const BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([type, t]) => [t.ext, type]));

export class Blobs {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "blobs");
    mkdirSync(this.dir, { recursive: true });
  }

  // Returns the blob name, or the problem.
  put(type: string, bytes: Uint8Array): { name: string } | { error: string } {
    const t = TYPES[type.split(";")[0].trim()];
    if (!t) return { error: `content type must be one of ${Object.keys(TYPES).join(", ")}` };
    if (bytes.length === 0) return { error: "the body is empty" };
    if (bytes.length > t.max) return { error: `at most ${t.max / 2 ** 20} MB for ${type}` };
    const name = `${createHash("sha256").update(bytes).digest("hex")}.${t.ext}`;
    const file = join(this.dir, name);
    if (!existsSync(file)) {
      writeFileSync(`${file}.tmp`, bytes);
      renameSync(`${file}.tmp`, file);
    }
    return { name };
  }

  putText(text: string): string {
    const r = this.put("text/plain", new TextEncoder().encode(text || " "));
    if ("error" in r) throw new Error(r.error);
    return r.name;
  }

  // The absolute path of a stored blob, or null (Part K: a task names its screenshots by path).
  path(name: string): string | null {
    if (!/^[0-9a-f]{64}\.[a-z0-9]+$/.test(name)) return null;
    const file = resolve(join(this.dir, name));
    return existsSync(file) ? file : null;
  }

  size(name: string): number | null {
    const file = this.path(name);
    return file ? statSync(file).size : null;
  }

  getText(name: string): string | null {
    if (!/^[0-9a-f]{64}\.txt$/.test(name)) return null;
    const file = join(this.dir, name);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  get(name: string, range: string | null): Response {
    if (!/^[0-9a-f]{64}\.[a-z0-9]+$/.test(name)) return new Response("not found", { status: 404 });
    const file = join(this.dir, name);
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    const size = statSync(file).size;
    const ext = name.split(".")[1];
    const type = ext === "txt" ? "text/plain; charset=utf-8" : (BY_EXT[ext] ?? "application/octet-stream");
    // nosniff: an agent's file (slice 7) is served as its listed type, never guessed into HTML.
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(Bun.file(file).slice(start, end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }
    return new Response(Bun.file(file), { headers: { ...headers, "Content-Length": String(size) } });
  }
}
