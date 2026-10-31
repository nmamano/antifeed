// Checks of what agents and Nil send. Each returns null or the problem.

import type { AnswerSchema, Block, Call, CommandAbout, Generic, Packet } from "./types";

// A command's plain words (slice 7): a title, and up to 8 rows of strings.
export function aboutError(a: CommandAbout): string | null {
  if (!a || typeof a !== "object" || typeof a.title !== "string" || !a.title.trim() || a.title.length > 300) return "title must be text of 1 to 300 characters";
  if (a.rows === undefined) return null;
  if (!Array.isArray(a.rows) || a.rows.length > 8) return "rows must be at most 8 pairs";
  for (const r of a.rows) if (!Array.isArray(r) || r.length !== 2 || r.some((x) => typeof x !== "string" || x.length > 4000)) return "each row is two strings of at most 4000 characters";
  return null;
}

export class EngineError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

const isStr = (v: unknown, max = 100_000) => typeof v === "string" && v.length <= max;
const BLOCK_TYPES = ["markdown", "diff", "image", "video", "link", "demo", "chart", "draft", "checklist", "fields", "code", "file", "fold"];

function checkBlocks(blocks: unknown, where: string, depth = 0): string | null {
  if (!Array.isArray(blocks)) return `${where} must be a list`;
  if (blocks.length > 200) return `${where} holds more than 200 blocks`;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Block;
    const at = `${where}[${i}]`;
    if (!b || typeof b !== "object" || !BLOCK_TYPES.includes(b.type)) return `${at}: unknown block type`;
    switch (b.type) {
      case "markdown":
        if (!isStr(b.text, 200_000)) return `${at}: text must be a string`;
        if (b.tone !== undefined && b.tone !== "warn") return `${at}: tone must be "warn" or absent`;
        break;
      case "diff":
        if (!isStr(b.unified, 500_000)) return `${at}: unified must be a string`;
        break;
      case "image":
      case "video":
        if (!isStr(b.blob, 200) || !/^[0-9a-f]{64}\.[a-z0-9]+$/.test(b.blob)) return `${at}: blob must be a blob name from POST /api/blobs`;
        if (b.type === "image" && b.focus !== undefined) {
          const f = b.focus as Record<string, unknown> & { x: number; y: number; w: number; h: number };
          const ok = !!f && typeof f === "object" && ["x", "y", "w", "h"].every((k) => typeof f[k] === "number" && f[k] >= 0 && f[k] <= 1) && f.w > 0 && f.h > 0 && f.x + f.w <= 1.000001 && f.y + f.h <= 1.000001;
          if (!ok) return `${at}: focus must be {x, y, w, h}, fractions of the image (0 to 1), inside it`;
        }
        if (b.type === "image" && b.wide !== undefined && typeof b.wide !== "boolean") return `${at}: wide must be true or false`;
        break;
      case "link":
        if (!isStr(b.url, 2000) || !/^https?:\/\//.test(b.url) || !isStr(b.label, 500)) return `${at}: link needs an http(s) url and a label`;
        break;
      case "demo":
        if (!isStr(b.url, 2000) || !/^https?:\/\//.test(b.url)) return `${at}: demo needs an http(s) url`;
        break;
      case "draft":
        if (!isStr(b.key, 100) || !isStr(b.text, 100_000)) return `${at}: draft needs a key and a text`;
        break;
      case "checklist":
        if (!Array.isArray(b.items) || !b.items.every((x) => isStr(x, 2000))) return `${at}: items must be strings`;
        break;
      case "fields":
        if (!Array.isArray(b.rows) || !b.rows.every((r) => Array.isArray(r) && r.length === 2 && isStr(r[0], 500) && isStr(r[1], 5000))) return `${at}: rows must be [label, value] pairs`;
        break;
      case "code":
        if (!isStr(b.text, 20_000)) return `${at}: code needs a text`;
        break;
      case "file":
        if (!isStr(b.blob, 200) || !/^[0-9a-f]{64}\.[a-z0-9]+$/.test(b.blob)) return `${at}: blob must be a blob name from POST /api/blobs`;
        if (!isStr(b.name, 500) || !b.name.trim()) return `${at}: file needs a name`;
        if (b.size !== undefined && (typeof b.size !== "number" || b.size < 0)) return `${at}: size must be a number of bytes`;
        break;
      case "fold": {
        if (depth > 3) return `${at}: folds nest more than 3 deep`;
        if (!isStr(b.title, 500)) return `${at}: fold needs a title`;
        const bad = checkBlocks(b.blocks, `${at}.blocks`, depth + 1);
        if (bad) return bad;
        break;
      }
    }
  }
  return null;
}

// Nil, 2026-10-30: "A cut off title that is missing instructions is useless.
// should never happen." No question Antifeed makes or shows is ever cut.
export const isCut = (t: string) => /(…|\.\.\.)$/.test(t.trim());

// A text's first line that is not blank, whole (Antifeed Reviewer's B2: a
// sentence cut is a cut too).
export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

// A board title the office cut (a task filed from an ask, at 120 characters):
// the description's whole first line, where the office puts the whole ask.
// With no description, the title without its "…".
export function wholeTitle(title: string, description: string): string {
  if (!isCut(title)) return title;
  return firstLine(description) || title.trim().replace(/(…|\.\.\.)$/, "").trim();
}

// Only an agent's packet (POST /api/cards) is refused for a cut question
// (Antifeed Reviewer's B1): a code packet takes the source's own words, and
// a "..." there is the writer's, not a cut.
export function checkAgentQuestion(p: Packet): string | null {
  return isCut(p.question) ? "packet.question is cut: give the whole title" : null;
}

// A question is never cut, so its limit is high: one long pasted line still gets its card (Antifeed Reviewer, 2026-10-30).
export const QUESTION_MAX = 20_000;

export function checkPacket(p: unknown): string | null {
  if (!p || typeof p !== "object") return "packet must be an object";
  const x = p as Packet;
  if (!isStr(x.question, QUESTION_MAX) || !x.question.trim()) return "packet.question is required";
  const bad = checkBlocks(x.blocks, "packet.blocks");
  if (bad) return bad;
  if (x.options !== undefined) {
    if (!Array.isArray(x.options) || x.options.length < 1 || x.options.length > 4) return "packet.options must hold 1 to 4 options";
    const ids = new Set<string>();
    for (const [i, o] of x.options.entries()) {
      if (!o || !isStr(o.id, 100) || !isStr(o.label, 500) || typeof o.fill !== "object" || o.fill === null) return `packet.options[${i}] needs id, label and fill`;
      if (ids.has(o.id)) return "option ids must differ";
      ids.add(o.id);
      if (o.blocks) {
        const b = checkBlocks(o.blocks, `packet.options[${i}].blocks`);
        if (b) return b;
      }
    }
  }
  if (x.recommended !== undefined && !(x.options ?? []).some((o) => o.id === x.recommended)) return "packet.recommended must name an option";
  if (x.limit !== undefined && (typeof x.limit !== "object" || x.limit === null || Object.values(x.limit).some((v) => v !== null && !(Array.isArray(v) && v.every((y) => y === null || isStr(y, 100)))))) return "packet.limit maps fields to a list of values or null";
  return null;
}

function draftKeys(blocks: Block[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.type === "draft") out.add(b.key);
    else if (b.type === "fold") draftKeys(b.blocks, out);
  }
  return out;
}

// Plain words (Nil, 2026-10-29: "Why am I being shown file names and code
// lines?? i don't operate at that level"): the text Nil reads on a card of a
// plainWords policy holds no code. Returns the first match as an error, or
// null. Checked: the markdown, the fold titles, checklist items, fields rows,
// link labels and captions (in folds and options too), each option's label,
// cost, fill.scope and fill.title; code and diff blocks are refused. Not
// checked: the question (the board's title), drafts and Nil's own text,
// predictions, and web addresses. Rules: Antifeed PM and Antifeed Reviewer,
// 2026-10-30. Accepted: "line 2 of the menu" is refused too (say "the second
// line"); a word with two slashes ("go/design/hold") is a path.
const FILE_EXT = /^[\w.-]+\.(ts|tsx|js|mjs|md|css|json|html|yml|yaml|sh|py|toml|lock|svg|txt|rs|go)$/i;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]+$/i;
function codeInText(text: string): { match: string; kind: string } | null {
  const t = text.replace(/https?:\/\/[^\s)>\]]+/g, " ");
  if (/```/.test(t)) return { match: "```", kind: "a code block" };
  const indented = /(?:^|\n[ \t]*\n)((?: {4}|\t)\S[^\n]*)/.exec(t);
  if (indented) return { match: indented[1].trim(), kind: "an indented code block" };
  const tick = /`[^`\n]+`/.exec(t);
  if (tick) return { match: tick[0], kind: "a code span" };
  const line = /\blines? \d+(\s*[-–]\s*\d+)?\b/i.exec(t);
  if (line) return { match: line[0], kind: 'a line reference (for a line of a page, say "the second line")' };
  for (const raw of t.split(/\s+/)) {
    const w = raw.replace(/^[("'\[]+/, "").replace(/[)"'\],;!?]+$/, "").replace(/[.:]+$/, "");
    if (!w) continue;
    const file = w.replace(/:\d+([-–]\d+)?$/, "");
    const slashes = (w.match(/\//g) ?? []).length;
    // A web address with no http ("office.example.com/nilmamano").
    if (slashes && HOST.test(w.slice(0, w.indexOf("/")))) continue;
    const pathLike = (x: string) => {
      const n = (x.match(/\//g) ?? []).length;
      // Two slashes ("/api/agents/:id", "server/backends/"), or one with a letter extension at the end.
      return n >= 2 || (n === 1 && /\.[a-z][a-z0-9]*$/i.test(x.slice(x.lastIndexOf("/") + 1)));
    };
    if (/:\d+([-–]\d+)?$/.test(w) && (FILE_EXT.test(file) || pathLike(file))) return { match: w, kind: "a line reference" };
    if (pathLike(w)) return { match: w, kind: "a file path" };
    // A product name (Next.js, Node.js) is not a file; client.js is.
    if (FILE_EXT.test(w) && !/^[A-Z][\w-]*\.js$/.test(w)) return { match: w, kind: "a file name" };
    // A commit hash: a whole lowercase hex word of 7 to 40 characters with a digit and a letter.
    if (/^[0-9a-f]{7,40}$/.test(w) && /\d/.test(w) && /[a-f]/.test(w)) return { match: w, kind: "a commit hash" };
  }
  return null;
}
// The texts of a block Nil reads, with where they are.
function blockTexts(b: Block, at: string): [string, string][] {
  switch (b.type) {
    case "markdown":
      return [[at, b.text]];
    case "fold":
      return [[`${at}.title`, b.title]];
    case "checklist":
      return b.items.map((x, j) => [`${at}.items[${j}]`, x]);
    case "fields":
      return b.rows.flatMap(([k, v], j) => [[`${at}.rows[${j}]`, k], [`${at}.rows[${j}]`, v]] as [string, string][]);
    case "link":
      return [[`${at}.label`, b.label]];
    case "image":
    case "video":
      return b.caption ? [[`${at}.caption`, b.caption]] : [];
    default:
      return [];
  }
}
function codeInBlocks(blocks: Block[] | undefined, at: string, folds = true): string | null {
  for (const [i, b] of (blocks ?? []).entries()) {
    const here = `${at}[${i}]`;
    // Antifeed PM, 2026-10-30: a triage packet has no use for a file block.
    if (b.type === "code" || b.type === "diff" || b.type === "file") return `${here}: a ${b.type} block ${b.type === "file" ? "has no place on this card" : "is code"}`;
    for (const [where, text] of blockTexts(b, here)) {
      const m = codeInText(text);
      if (m) return `${where}: "${m.match}" is ${m.kind}`;
    }
    if (b.type === "fold" && folds) {
      const f = codeInBlocks(b.blocks, `${here}.blocks`);
      if (f) return f;
    }
  }
  return null;
}
// aboveFolds (Part J, sign-off): the question and what shows above the folds
// are checked, the folds' contents are not (they hold file paths by design).
export function codeInPacket(p: Packet, aboveFolds = false): string | null {
  const q = aboveFolds ? codeInText(p.question ?? "") : null;
  const hit =
    (q ? `packet.question: "${q.match}" is ${q.kind}` : null) ??
    codeInBlocks(p.blocks, "packet.blocks", !aboveFolds) ??
    (p.options ?? []).reduce<string | null>((found, o, i) => {
      if (found) return found;
      for (const [k, v] of [["label", o.label], ["cost", o.cost], ["fill.scope", o.fill?.scope], ["fill.title", o.fill?.title]] as const) {
        const m = typeof v === "string" ? codeInText(v) : null;
        if (m) return `packet.options[${i}].${k}: "${m.match}" is ${m.kind}`;
      }
      return codeInBlocks(o.blocks, `packet.options[${i}].blocks`);
    }, null);
  return hit ? `${hit}. Say it in a member's words: what they see, not where it is in the code.` : null;
}

// A predictor copies an option's text (triage's scope, a field marked inLine
// "option") into its call; a copy that differs only in white space is the
// option's own text, so the Premove's option is exact. Other text (an ask's
// reply) keeps its own lines.
const ws = (v: string) => v.replace(/\s+/g, " ").trim();
export function snapToOptions(answer: AnswerSchema, call: Call, packet: Packet | null): Call {
  if (!call || typeof call !== "object") return call;
  const out: Call = { ...call };
  for (const [k, v] of Object.entries(call)) {
    if (answer[k]?.inLine !== "option" || typeof v !== "string") continue;
    const o = (packet?.options ?? []).find((x) => typeof x.fill[k] === "string" && ws(x.fill[k]) === ws(v));
    if (o) out[k] = o.fill[k];
  }
  return out;
}

// A call fits the policy's answer schema; draft keys and the note are free text.
export function checkCall(answer: AnswerSchema, call: Call, generic: Generic | undefined, packet: Packet | null): string | null {
  if (!call || typeof call !== "object") return "call must be an object";
  const note = call.note ?? "";
  if (typeof note !== "string" || note.length > 4000) return "note must be a string of at most 4000 characters";
  if (generic) {
    if (generic.kind === "rewrite") return note.trim() ? null : "rewrite needs a note: what to write differently";
    if (generic.kind === "refine") return (packet?.options ?? []).some((o) => o.id === generic.option) ? null : "refine must name an option of the packet";
    return "unknown generic call";
  }
  const drafts = draftKeys(packet?.blocks ?? []);
  for (const [k, v] of Object.entries(call)) {
    if (k === "note") continue;
    const f = answer[k];
    if (!f) {
      if (drafts.has(k) && typeof v === "string" && v.length <= 100_000) continue;
      return `"${k}" is not a field of this decision`;
    }
    if (f.enum && !f.enum.includes(v ?? null)) return `${k} must be one of ${f.enum.map(String).join(", ")}`;
    if (f.text && v != null && (typeof v !== "string" || v.length > f.text.max)) return `${k} must be text of at most ${f.text.max} characters`;
  }
  for (const [k, f] of Object.entries(answer)) if (k !== "note" && f.enum && !f.enum.includes(null) && !(k in call)) return `${k} is required`;
  for (const [k, vals] of Object.entries(packet?.limit ?? {})) {
    const v = call[k] ?? null;
    if (vals === null ? v !== null : !vals.includes(v)) return vals === null ? `${k} is not a field of this card` : `${k} must be one of ${vals.map(String).join(", ")} on this card`;
  }
  return checkRules(answer, call);
}

// The fields' needs and noneWith rules (the page runs the same check).
export function checkRules(answer: AnswerSchema, call: Call): string | null {
  for (const [k, f] of Object.entries(answer)) {
    const label = (f.label ?? k).toLowerCase();
    for (const [other, values] of Object.entries(f.needs ?? {}))
      // "a priority", but "words" (slice 7) takes no article.
      if (values.includes(call[other] ?? null) && (call[k] ?? null) === null) return `${call[other]} needs ${/s$/.test(label) ? "" : "a "}${label}`;
    for (const [other, values] of Object.entries(f.noneWith ?? {}))
      if (values.includes(call[other] ?? null) && (call[k] ?? null) !== null) return `${call[other]} takes no ${label}`;
  }
  return null;
}
