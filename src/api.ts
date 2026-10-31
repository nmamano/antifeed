// The HTTP API (DESIGN.md sections 1 and 7). Agent routes take requests on
// 127.0.0.1 with no auth and never write as a human. Human routes need the
// X-Isomux-Member-Id that the office adds on its app URL, equal to Nil's id.
// A direct request to the port can set that header too: the check stops
// mistakes, not a process on the box that forges it on purpose.

import type { Blobs } from "./blobs";
import { EngineError, INPUT_IMAGE, INPUT_IMAGE_BYTES, type Engine } from "./engine";
import { calibration, weekly } from "./metrics";
import { lineText } from "./predictor";
import { appleIcon, icon, pageHtml } from "./page";
import type { Call, DeciderConfig, Event, Generic, Packet } from "./types";

export const MEMBER_HEADER = "x-isomux-member-id";
const JSON_MAX = 4 * 2 ** 20;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

export type ApiOptions = {
  engine: Engine;
  blobs: Blobs;
  member: string;
  base: string;
  status?: () => Record<string, unknown>;
  // The page's one read (src/view.ts) and its version for If-None-Match.
  view?: () => unknown;
  etag?: () => string;
  context?: (card: string) => unknown;
  // Takes a chat message of Nil's to the card's consult (src/chat.ts).
  chat?: (e: Event) => Promise<void>;
  // Round q1, I: files an input of Nil's and tells its PM, or tells again (src/input.ts).
  input?: (id: string, tellOnly?: boolean) => Promise<void>;
  criteria?: (policy: string) => string | null;
};

export function help(base: string): string {
  return `Antifeed API. Base: ${base}

Agent routes (no auth on 127.0.0.1; they never write as a human):
GET  /api/commands/:id            the command: type, policy, actor, subject, card, params, state
POST /api/commands/:id/start      before you act on any command. 409: it was cancelled, finished, or started by another
                                  delivery; do not act.
POST /api/commands/:id/result     {"ok":true,"data?":...} or {"ok":false,"error":"..."}. A repeat is dropped (duplicate: true).
POST /api/commands/:id/prediction the consult agent's answer to a started predict command:
                                  {"call":{...},"confidence":0-1,"why":"...","against":"...","informed?":true}. 409: the card
                                  moved on, or the command is not started.
GET  /api/consult/context         for a consult agent: the card Nil has open now, with the input it was sent, its raw
                                  answer, the Premove (its own or a stand-in and why) and the decision so far
GET  /api/cards/:id/context       the same for one card, with the card's chat ("thread"), oldest first
POST /api/cards/:id/chat/:reply/reply {"text"}: the consult's answer to Nil's chat message; the reply id comes in
                                  the office message, and takes one answer. 409: unknown or used id
POST /api/cards                   a packet: {"command":"<id>","packet":{...},"meta":{"raw":"<link to the source>"}}
                                  answers that prepare command and reports it done. Without "command": {"policy","actor","subject",
                                  "packet","meta"}, for an actor the policy lists as an author. When that author has an open card for the
                                  subject, the post is the card's new packet version, not a new card.
                                  packet: {"question","blocks":[...],"options?":[{"id","label","cost?","fill":{...}}] (1-4),
                                  "recommended?":"<option id>"}. Blocks: markdown {text}, diff {unified,path?}, image/video {blob,
                                  caption?}, link {url,label}, demo {url}, chart {spec}, draft {key,text}, checklist {items},
                                  fields {rows}, fold {title,blocks}. meta.raw is required.
POST /api/blobs                   raw bytes with Content-Type image/png|jpeg|webp|gif or video/mp4|webm -> {"blob":"<name>"}
GET  /api/blobs/:name             the bytes (Range requests answer 206)
POST /api/events                  {"project","from":"<your actor id>","type","subject?","data?","key?"}: a fact that is
                                  not a command result, only a type the policies file lets you emit. A repeated key is dropped.
GET  /api/policies/:id/past-calls[?after=<time>]   a policy's past calls by Nil, newest first, each {id,at,text};
                                  with after, only the newer ones. A predict input names this route and the count
POST /api/policies/:id/reprepare {revise}   a new packet for each open card of the policy, from its author, with
                                  the revise note; issued a few at a time. Returns {cards, skipped}: the cards asked, and
                                  those with no earlier prepare to send again
POST /api/cards/:id/withdraw      {"actor","reason"}: the card's author withdraws its open card. 403: not its author;
                                  409: the card is decided, done or withdrawn
GET  /api/cards?state=open|all&policy=   cards, newest first
GET  /api/cards/:id               one card
GET  /api/status                  commands in flight, failures, replay differences, the log's state

Human routes (Nil, through the office URL):
POST /api/cards/:id/decide        {"version","call":{...,"note?"},"generic?":{"kind":"rewrite"}|{"kind":"refine","option"},"shownAt?","option?"}
POST /api/cards/:id/chat         {"text"}: Nil's words to the card's consult (at most 4000 characters)
POST /api/cards/:id/shown         {"version"}: Nil could see this version's Premove (once per version)
POST /api/inputs                  {"text","target","page","card?","clientId","images?"}: Nil's input, filed as an untagged task on the
                                  target's board (images: at most 4 blob names from POST /api/blobs, PNG, JPEG or WebP,
                                  each at most 8 MB, listed at the end of the task as "Screenshot: <server path>"), then its PM is told. The same clientId again files once
POST /api/inputs/:id/tell         tell the PM again of an input whose task is filed
POST /api/consult/focus           {"card"}: the card Nil has open, for the consult agent
GET  /api/view                    everything the page shows except Status; ETag, If-None-Match answers 304
POST /api/cards/:id/undo          a decision, or a held action within its 24 s
POST /api/cards/:id/action        {"ok":true|false,"note?"} for an action card: held 24 s for an Undo, then sent
POST /api/policies/:id/decider    {"config":{...}}: nil, or the decider the policies file names (autoAllowed only)
GET  /api/calibration?policy=     bands per predictor version
GET  /api/weekly                  DPM and eDPM per week (Pacific), with the match rate
GET  /api/policies                each policy: events, commands, answer fields, decider (as it runs and as the file names it)
GET  /api/flow                    projects, actors, sources, events, and how often each event type happened
`;
}

async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > JSON_MAX) throw new EngineError(400, `the body is larger than ${JSON_MAX / 2 ** 20} MB`);
  const text = await req.text();
  if (text.length > JSON_MAX) throw new EngineError(400, `the body is larger than ${JSON_MAX / 2 ** 20} MB`);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new EngineError(400, "the body is not JSON");
  }
}

export function makeApi(o: ApiOptions): (req: Request) => Promise<Response> {
  const { engine } = o;
  const human = (req: Request): string => {
    const m = req.headers.get(MEMBER_HEADER);
    if (!m || m !== o.member) throw new EngineError(403, "this route is Nil's: open it through the office URL");
    return m;
  };
  // The card Nil has open (POST /api/consult/focus): in memory, not logged.
  let focus: string | null = null;
  return async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    const m = req.method;
    try {
      if (m === "GET" && p === "/api/help") return new Response(help(o.base), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (m === "GET" && p === "/icon.svg") return new Response(icon, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" } });
      if (m === "GET" && p === "/apple-touch-icon.png") return new Response(appleIcon, { headers: { "Content-Type": "image/png", "Cache-Control": "max-age=86400" } });
      if (m === "GET" && p === "/favicon.ico") return fail(404, "not found");
      if (seg[0] !== "api") return m === "GET" ? new Response(pageHtml(o.view ? JSON.stringify(o.view()) : "null"), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }) : fail(404, "not found");
      if (p === "/api/view" && m === "GET" && o.view) {
        const tag = `"${o.etag?.() ?? ""}"`;
        if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
        return Response.json(o.view(), { headers: { ETag: tag, "Cache-Control": "no-cache" } });
      }
      if (p === "/api/consult/context" && m === "GET") {
        const id = focus;
        return json(id && o.context ? { focus: id, ...(o.context(id) as object) } : { focus: null, note: "Nil has no card open in Antifeed now; ask him which card he means." });
      }
      if (p === "/api/consult/focus" && m === "POST") {
        human(req);
        const b = await body<{ card?: unknown }>(req);
        if (typeof b.card !== "string" || !engine.cards.has(b.card)) throw new EngineError(400, "card must be a card id");
        focus = b.card;
        return json({ focus });
      }
      // Round q1, I: Nil's input that becomes a task.
      if (p === "/api/inputs" && m === "POST") {
        const who = human(req);
        const b = await body<{ images?: unknown }>(req);
        // Part K: each screenshot is a stored blob of at most 8 MB.
        if (Array.isArray(b.images))
          for (const name of b.images) {
            const size = typeof name === "string" && INPUT_IMAGE.test(name) ? o.blobs.size(name) : null;
            if (size === null) throw new EngineError(400, "a screenshot did not upload; add it again");
            if (size > INPUT_IMAGE_BYTES) throw new EngineError(400, `a screenshot is at most ${INPUT_IMAGE_BYTES / 2 ** 20} MB`);
          }
        const r = engine.inputSend(who, b);
        if (!r.duplicate) void o.input?.(r.event.id).catch((err) => console.error(`input send: ${(err as Error).message}`));
        return json({ id: r.event.id, duplicate: r.duplicate });
      }
      if (seg[1] === "inputs" && seg[2] && seg[3] === "tell" && seg.length === 4 && m === "POST") {
        const e = engine.inputTell(human(req), seg[2]);
        void o.input?.(seg[2], true).catch((err) => console.error(`input tell: ${(err as Error).message}`));
        return json({ id: e.id });
      }
      if (seg[1] === "criteria" && seg[2] && m === "GET") {
        const t = o.criteria?.(seg[2]) ?? null;
        return t === null ? fail(404, "no criteria file for this policy") : new Response(t, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      // ---- agent routes
      if (seg[1] === "commands" && seg[2]) {
        const id = seg[2];
        if (m === "GET" && seg.length === 3) {
          const k = engine.commands.get(id);
          return k ? json(k) : fail(404, "unknown command");
        }
        if (m === "POST" && seg[3] === "start") return json({ events: engine.startCommand(id).length });
        if (m === "POST" && seg[3] === "prediction") return json({ events: engine.predictionResult(id, await body<unknown>(req)).length });
        if (m === "POST" && seg[3] === "result") {
          const b = await body<{ ok?: unknown; data?: unknown; error?: unknown }>(req);
          if (typeof b.ok !== "boolean") throw new EngineError(400, "ok must be true or false");
          if (b.error !== undefined && typeof b.error !== "string") throw new EngineError(400, "error must be a string");
          const r = engine.commandResult(id, { ok: b.ok, data: b.data, error: b.error as string | undefined });
          return json({ duplicate: r.duplicate });
        }
      }
      if (p === "/api/cards" && m === "POST") {
        const b = await body<{ command?: string; policy?: string; actor?: string; subject?: string; packet: Packet; meta: { raw: string } }>(req);
        const events = engine.postPacket(b);
        return json({ card: events.find((e) => e.card)?.card ?? null }, 201);
      }
      if (p === "/api/cards" && m === "GET") {
        const state = url.searchParams.get("state") ?? "open";
        const policy = url.searchParams.get("policy");
        // state=all also lists the cards of a policy that is off (B4), to read
        // only: the agents that took over its work read them (DESIGN.md 22).
        const cards = [...engine.cards.values()].filter((c) => (state === "all" || c.state === state) && (!policy || c.policy === policy) && (state === "all" || engine.cardOn(c))).reverse();
        return json({ cards });
      }
      if (p === "/api/blobs" && m === "POST") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const r = o.blobs.put(req.headers.get("content-type") ?? "", bytes);
        return "error" in r ? fail(400, r.error) : json({ blob: r.name }, 201);
      }
      if (seg[1] === "blobs" && seg[2] && m === "GET") return o.blobs.get(seg[2], req.headers.get("range"));
      if (p === "/api/events" && m === "POST") {
        const b = await body<{ project: string; from: string; type: string; subject?: string; data?: unknown; key?: string }>(req);
        for (const f of ["project", "from", "type"] as const) if (typeof b[f] !== "string") throw new EngineError(400, `${f} is required`);
        const r = engine.reportEvent(b);
        return json({ duplicate: r.duplicate }, r.duplicate ? 200 : 201);
      }
      if (p === "/api/status" && m === "GET") {
        // Part J, B4: the commands of a policy that is off are not counted.
        const commands = [...engine.commands.values()].filter((k) => !["done", "cancelled"].includes(k.state) && engine.commandOn(k));
        return json({
          inFlight: commands.filter((k) => k.state !== "failed"),
          failed: engine.failures(),
          replayDiffs: engine.replayDiffs,
          // The cards a re-prepare has not asked yet.
          reprepareLeft: engine.reprepareLeft(),
          log: { torn: engine.log.torn, broken: engine.log.broken },
          decisionsRebuilt: engine.decisions.rebuilt,
          ...(o.status?.() ?? {}),
        });
      }

      // ---- card reads and human routes
      if (seg[1] === "cards" && seg[2]) {
        const id = seg[2];
        if (m === "GET" && seg.length === 3) {
          const c = engine.cards.get(id);
          return c ? json(c) : fail(404, "unknown card");
        }
        if (m === "GET" && seg[3] === "context") {
          const x = o.context?.(id);
          return x ? json(x) : fail(404, "unknown card");
        }
        // Part G: an agent route, for the card's author.
        if (m === "POST" && seg[3] === "withdraw" && seg.length === 4) {
          const b = await body<{ actor?: unknown; reason?: unknown }>(req);
          return json({ events: engine.withdrawCard(id, b).length });
        }
        if (m === "POST" && seg[3] === "shown") {
          const who = human(req);
          const b = await body<{ version?: unknown }>(req);
          if (typeof b.version !== "number") throw new EngineError(400, "version is required");
          return json({ events: engine.cardShown(who, id, b.version).length });
        }
        if (m === "POST" && seg[3] === "decide") {
          const who = human(req);
          const b = await body<{ version: number; call: Call; generic?: Generic; shownAt?: string; option?: string }>(req);
          if (typeof b.version !== "number") throw new EngineError(400, "version is required: the packet version you saw");
          if (b.shownAt !== undefined && Number.isNaN(Date.parse(b.shownAt))) throw new EngineError(400, "shownAt must be a time");
          if (b.option !== undefined && typeof b.option !== "string") throw new EngineError(400, "option must be an option id");
          engine.decide(who, id, b);
          return json(engine.cards.get(id));
        }
        // The slice 5 chat moved to the office chat beside the app (DESIGN.md 13.1).
        if (m === "POST" && seg[3] === "consult") return fail(410, "ask the card's consult agent in its own office chat (the card's Questions? link); the chat beside the app is for the app itself");
        // Round q1, H1: Nil's chat with the card's consult, and its answer.
        if (m === "POST" && seg[3] === "chat" && seg.length === 4) {
          const who = human(req);
          const b = await body<{ text?: unknown }>(req);
          const e = engine.chatSend(who, id, b.text);
          void o.chat?.(e).catch((err) => console.error(`chat send: ${(err as Error).message}`));
          return json({ id: e.id });
        }
        if (m === "POST" && seg[3] === "chat" && seg.length === 6 && seg[5] === "reply") {
          const b = await body<{ text?: unknown }>(req);
          return json({ id: engine.chatReply(id, seg[4], b.text).id });
        }
        if (m === "POST" && seg[3] === "undo") {
          engine.undo(human(req), id);
          return json(engine.cards.get(id));
        }
        if (m === "POST" && seg[3] === "action") {
          const who = human(req);
          const b = await body<{ ok?: unknown; note?: unknown }>(req);
          if (typeof b.ok !== "boolean") throw new EngineError(400, "ok must be true or false");
          engine.completeAction(who, id, { ok: b.ok, note: typeof b.note === "string" ? b.note : undefined });
          return json(engine.cards.get(id));
        }
      }
      if (seg[1] === "policies" && seg[2] && seg[3] === "decider" && m === "POST") {
        const who = human(req);
        const b = await body<{ config: DeciderConfig }>(req);
        engine.setDecider(who, seg[2], b.config);
        return json(engine.deciderOf(seg[2]));
      }
      // A new packet for each open card of a policy, from its author (Antifeed PM, 2026-10-29:
      // the triage packet shape changed). The clock issues the prepares a few at a time.
      if (seg[1] === "policies" && seg[2] && seg[3] === "reprepare" && seg.length === 4 && m === "POST") {
        const b = await body<{ revise?: unknown }>(req);
        return json(engine.reprepare(seg[2], b.revise as string, "code:reprepare"));
      }
      if (p === "/api/calibration" && m === "GET") {
        const policy = url.searchParams.get("policy") ?? "";
        const set = engine.deciderOf(policy);
        const sw = set.setAt && set.config?.kind === "threshold" ? { at: set.setAt, min: set.config.min } : null;
        return json({ policy, decider: set, calibration: calibration(engine.decisions.live(), policy, sw) });
      }
      if (p === "/api/weekly" && m === "GET") return json({ weeks: weekly(engine.decisions.live()) });
      // A policy's past calls for its consult agent (Nil, 2026-10-29): the predict input names
      // this route and the count, not the calls. Newest first; ?after=<time> gives only newer ones.
      if (seg[1] === "policies" && seg[2] && seg[3] === "past-calls" && seg.length === 4 && m === "GET") {
        if (!engine.policies().some(({ policy: x }) => x.id === seg[2])) return fail(404, "unknown policy");
        const all = engine.decisions.precedent(seg[2]);
        const after = url.searchParams.get("after");
        if (after !== null && Number.isNaN(Date.parse(after))) throw new EngineError(400, "after must be a time");
        const calls = after === null ? all : all.filter((l) => Date.parse(l.at) > Date.parse(after));
        return json({ policy: seg[2], n: all.length, newestAt: all[0]?.at ?? null, calls: calls.map((l) => ({ id: l.id, at: l.at, text: lineText(l) })) });
      }
      if (p === "/api/policies" && m === "GET")
        return json({
          policies: engine.policies().map(({ policy: x, project, builtin }) => ({
            id: x.id, project, builtin, on: x.on, emits: x.emits, final: x.final ?? [], commands: x.commands, answer: x.answer ?? null,
            primary: x.primary ?? [], prepare: x.prepare ?? null, author: x.author ?? null, autoAllowed: x.autoAllowed === true, cardKind: x.cardKind ?? null,
            fileDecider: x.decider ?? null, ...engine.deciderOf(x.id),
          })),
        });
      // The flow view: what can happen (the policies) and what did (event counts per type and policy).
      if (p === "/api/flow" && m === "GET") {
        const counts: Record<string, number> = {};
        for (const e of engine.log.all()) if (e.type !== "batch.end") counts[e.type] = (counts[e.type] ?? 0) + 1;
        const projects = engine.projects().map((d) => ({ project: d.project, actors: d.actors, sources: d.sources ?? [], events: d.events }));
        return json({ projects, counts, replayDiffs: engine.replayDiffs });
      }
      return fail(404, "not found");
    } catch (err) {
      if (err instanceof EngineError) return fail(err.status, err.message);
      console.error(`api ${m} ${p}: ${(err as Error).stack ?? err}`);
      return fail(500, (err as Error).message);
    }
  };
}
