// The per-project policies file (DESIGN.md section 6) and its load check.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Actor, DeciderConfig, DeciderStep, Policy } from "./types";
import { checkCall } from "./validate";

export type Source = { id: string; kind: string; [k: string]: unknown };

// What a code actor may use (slice 7: the inbox's office actor answers asks and acks pages).
// card: a read-only copy of a card (the walkthrough's code consult reads the packet it predicts).
// A code actor throws this when its command fails for a cause that holds
// until someone fixes it (a switch that is off): a retry now fails the same
// way, so the failed-command card does not offer one as its Premove.
// detail (any of the three): the raw cause (an HTTP status, a fetch error),
// for the failed-command card's ids fold; the message is in Nil's words.
export class Blocked extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}
// A code actor throws this when it cannot know if its at-most-once send went
// out (no answer from the office after the request left): a retry may send
// it twice, so the failed-command card does not offer one as its Premove.
export class MaybeSent extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}
// A plain failure in Nil's words, with its raw cause.
export class Failed extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
  }
}

// api: Antifeed's own address, for a line an agent can read back (slice 8).
export type RunContext = { office: import("./office").Office; card: (id: string) => import("./types").Card | undefined; api?: string };

// A code decider: the handler gets the card, the policy state and the
// precedent, as a Decider does.
export type Handler = (input: { card: import("./types").Card; state: unknown; precedent: import("./types").DecisionLine[] }) => DeciderStep | Promise<DeciderStep>;

export type ProjectDef = {
  project: string;
  // The project's plain name on the page ("Wall Game"), where its id is not one.
  name?: string;
  actors: Actor[];
  sources?: Source[];
  // Project events and who emits them: a source id, an actor id or a policy
  // id. `what` says what the event is, in words, for the page (round 10).
  events: Record<string, { from: string | string[]; what?: string }>;
  policies: Policy[];
  handlers?: Record<string, Handler>;
  // Code actors: a command to { kind: "code", handler } runs run[handler](command, ctx).
  run?: Record<string, (command: import("./engine").CommandRec, ctx: RunContext) => unknown>;
  // Code actors that take a burst at once (slice 8: one message for a burst
  // of calls): runBatch[handler](commands, ctx) gives one result per
  // command, in order, or throws, and then every command of the run fails.
  runBatch?: Record<string, (commands: import("./engine").CommandRec[], ctx: RunContext) => Promise<unknown[]>>;
  // Metadata only.
  agents?: Record<string, string>;
  // The actor id of the project's consult agent: it predicts each card and
  // answers Nil in the office chat (DESIGN.md 13.1).
  consult?: string;
  // Shown on the page about the consult agent: its handoff point and the
  // text of its instructions (its tools and limits).
  consultInfo?: { handoffTokens?: number; instructions?: string };
};

export function definePolicies(def: ProjectDef): ProjectDef {
  return def;
}

// Event types only the engine emits (section 4).
export const GENERIC_PREFIXES = ["card.", "command.", "policy.", "policies.", "clock.", "consult.", "batch.", "precedent.", "action.", "chat.", "input."];
export const isGeneric = (type: string) => GENERIC_PREFIXES.some((p) => type.startsWith(p));

const fromList = (f: string | string[]) => (Array.isArray(f) ? f : [f]);

function checkDecider(c: DeciderConfig | undefined, where: string, def: ProjectDef, problems: string[]): void {
  if (!c || typeof c !== "object") return void problems.push(`${where}: decider is not an object`);
  switch (c.kind) {
    case "code":
      if (!def.handlers?.[c.handler]) problems.push(`${where}: code decider names unknown handler "${c.handler}"`);
      return;
    case "agent":
      if (typeof c.model !== "string" || typeof c.criteria !== "string") problems.push(`${where}: agent decider needs model and criteria`);
      return;
    case "consult":
      if (typeof c.criteria !== "string") problems.push(`${where}: consult decider needs criteria`);
      // A project with no consult agent (the Inbox for now, 2026-10-28): the stand-in makes each Premove.
      return;
    case "nil":
      // Every decision card has a Premove (DESIGN.md 13.1).
      if (!c.predictor) problems.push(`${where}: a nil decider needs a predictor`);
      else checkDecider(c.predictor, `${where}.predictor`, def, problems);
      return;
    case "threshold":
      if (!(typeof c.min === "number" && c.min > 0 && c.min <= 1)) problems.push(`${where}: threshold min must be in (0, 1]`);
      checkDecider(c.agent, `${where}.agent`, def, problems);
      return;
    default:
      problems.push(`${where}: unknown decider kind "${(c as { kind: unknown }).kind}"`);
  }
}

// The load check. An empty list means the project loads.
export function checkProject(def: ProjectDef): string[] {
  const problems: string[] = [];
  if (!def.project || !/^[a-z0-9-]+$/.test(def.project)) problems.push("project id must be lowercase letters, digits and hyphens");
  const actorIds = new Set<string>();
  for (const a of def.actors ?? []) {
    if (actorIds.has(a.id)) problems.push(`actor "${a.id}" is declared twice`);
    actorIds.add(a.id);
    if (a.kind === "code" && typeof def.run?.[a.handler] !== "function" && typeof def.runBatch?.[a.handler] !== "function") problems.push(`code actor "${a.id}" names unknown run handler "${a.handler}"`);
  }
  if (def.consult !== undefined) {
    const a = (def.actors ?? []).find((x) => x.id === def.consult);
    if (!a) problems.push(`consult "${def.consult}" is not a declared actor`);
    else if (a.kind === "human") problems.push(`consult "${def.consult}" must be an agent or code actor`);
  }
  const sourceIds = new Set((def.sources ?? []).map((s) => s.id));
  const policyIds = new Set<string>();
  for (const p of def.policies ?? []) {
    if (policyIds.has(p.id)) problems.push(`policy "${p.id}" is declared twice`);
    policyIds.add(p.id);
  }
  const emitters = new Set([...actorIds, ...sourceIds, ...policyIds]);
  for (const [type, d] of Object.entries(def.events ?? {})) {
    if (isGeneric(type)) problems.push(`event "${type}" uses a generic prefix; only the engine emits those`);
    for (const f of fromList(d.from)) if (!emitters.has(f)) problems.push(`event "${type}" names unknown emitter "${f}"`);
  }
  const subscribed = new Map<string, string[]>();
  const emitted = new Map<string, string[]>();
  for (const p of def.policies ?? []) {
    const where = `policy "${p.id}"`;
    if (typeof p.reduce !== "function") problems.push(`${where}: reduce is not a function`);
    if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim())) problems.push(`${where}: name must be a non-empty string`);
    if (p.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(p.color))) problems.push(`${where}: color must be #rrggbb`);
    // The consult agent predicts and explains; it never writes a packet or acts (DESIGN.md 13.1).
    if (def.consult !== undefined) {
      if ((p.author === undefined ? [] : fromList(p.author)).includes(def.consult)) problems.push(`${where}: the consult agent "${def.consult}" cannot be an author`);
      for (const [type, c] of Object.entries(p.commands ?? {})) if (c.actor === def.consult) problems.push(`${where}: command "${type}" goes to the consult agent, which only predicts`);
    }
    for (const t of p.on ?? []) subscribed.set(t, [...(subscribed.get(t) ?? []), p.id]);
    for (const t of p.emits ?? []) {
      if (isGeneric(t)) problems.push(`${where}: emits generic type "${t}"`);
      emitted.set(t, [...(emitted.get(t) ?? []), p.id]);
      const decl = def.events?.[t];
      if (!decl || !fromList(decl.from).includes(p.id)) problems.push(`${where}: emits "${t}", but events does not list it as an emitter`);
    }
    for (const t of p.final ?? []) if (!(p.emits ?? []).includes(t)) problems.push(`${where}: final "${t}" is not in its emits`);
    for (const [type, c] of Object.entries(p.commands ?? {})) {
      if (!actorIds.has(c.actor)) problems.push(`${where}: command "${type}" names unknown actor "${c.actor}"`);
      if (c.delivery !== "at-least-once" && c.delivery !== "at-most-once") problems.push(`${where}: command "${type}" needs delivery at-least-once or at-most-once`);
    }
    for (const a of p.author === undefined ? [] : fromList(p.author)) if (!actorIds.has(a)) problems.push(`${where}: author "${a}" is not a declared actor`);
    if (p.decider !== undefined) {
      checkDecider(p.decider, where, def, problems);
      if (!p.answer) problems.push(`${where}: a policy with a decider needs an answer schema`);
      // The last stand-in: a safe default, never an arbitrary first value (DESIGN.md 13.7).
      if (p.noDefault !== undefined) {
        if (typeof p.noDefault !== "string" || !p.noDefault.trim()) problems.push(`${where}: noDefault must be the words why there is no safe default`);
        if (p.fallback) problems.push(`${where}: a policy with noDefault names no fallback call`);
      } else if (!p.fallback) problems.push(`${where}: a policy with a decider needs a fallback call`);
      else if (p.answer) {
        const bad = checkCall(p.answer, p.fallback, undefined, null) ?? p.validate?.(p.fallback) ?? null;
        if (bad) problems.push(`${where}: fallback: ${bad}`);
      }
    }
    for (const [k, f] of Object.entries(p.answer ?? {}))
      for (const other of [...Object.keys(f.needs ?? {}), ...Object.keys(f.noneWith ?? {})]) if (!p.answer?.[other]) problems.push(`${where}: field "${k}" has a rule on unknown field "${other}"`);
    if (p.prepare !== undefined && !p.commands?.[p.prepare]) problems.push(`${where}: prepare "${p.prepare}" is not in its commands`);
    for (const f of p.primary ?? []) if (!p.answer?.[f] && typeof p.derived?.[f] !== "function") problems.push(`${where}: primary field "${f}" is not in its answer or its derived values`);
    for (const f of Object.keys(p.derived ?? {})) if (p.answer?.[f]) problems.push(`${where}: derived value "${f}" is also an answer field`);
    if (p.undoUntilSent !== undefined && (typeof p.undoUntilSent !== "string" || !p.undoUntilSent.trim())) problems.push(`${where}: undoUntilSent must be the words that refuse the Undo`);
  }
  // Flow check: every emitted event has a subscriber or is final; every
  // subscribed event has an emitter.
  for (const [t, by] of emitted) {
    const final = (def.policies ?? []).filter((p) => by.includes(p.id)).every((p) => p.final?.includes(t));
    if (!subscribed.has(t) && !final) problems.push(`event "${t}" (from ${by.join(", ")}) has no subscriber and is not final`);
  }
  for (const [type, d] of Object.entries(def.events ?? {}))
    if (!subscribed.has(type) && fromList(d.from).every((f) => !policyIds.has(f))) problems.push(`event "${type}" has no subscriber`);
  for (const [t, by] of subscribed) {
    if (isGeneric(t)) continue;
    if (!def.events?.[t]) problems.push(`event "${t}" (subscribed by ${by.join(", ")}) has no emitter`);
  }
  return problems;
}

export type LoadedProject = { def: ProjectDef; path: string; hash: string };
export type LoadResult = { loaded: LoadedProject[]; refused: { path: string; problems: string[] }[] };

// The hash of the policies folder: the file, its reducers and criteria files.
export function folderHash(path: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const f = join(dir, name);
      if (statSync(f).isDirectory()) walk(f);
      else h.update(name).update("\0").update(readFileSync(f)).update("\0");
    }
  };
  walk(dirname(path));
  return h.digest("hex").slice(0, 12);
}

// Imports each policies file. A project that fails the check does not load;
// the others run.
export async function loadProjects(paths: string[]): Promise<LoadResult> {
  const out: LoadResult = { loaded: [], refused: [] };
  for (const path of paths) {
    try {
      const hash = folderHash(path);
      const mod = await import(path);
      const def = mod.default as ProjectDef;
      const problems = checkProject(def);
      if (problems.length) out.refused.push({ path, problems });
      else out.loaded.push({ def, path, hash });
    } catch (err) {
      out.refused.push({ path, problems: [`cannot load: ${(err as Error).message}`] });
    }
  }
  return out;
}
