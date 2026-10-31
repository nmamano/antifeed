// The decision log (DESIGN.md section 5): decisions.jsonl, one line per
// decided card version, and one undo line per Undo. events.jsonl is the
// truth: every line is a function of the events, so the file is checked and
// rebuilt from them at load.

import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AnswerSchema, Block, Call, CardMeta, DecisionLine, Event, Generic, Outcome, Packet, Prediction, UndoLine } from "./types";

const norm = (v: unknown) => (v === undefined || v === "" ? null : v);

function drafts(blocks: Block[], out: Map<string, string> = new Map()): Map<string, string> {
  for (const b of blocks) {
    if (b.type === "draft") out.set(b.key, b.text);
    else if (b.type === "fold") drafts(b.blocks, out);
  }
  return out;
}

// matched: every answer field equal and no note (other than an option's own)
// or draft edit. edited: the
// primary fields equal, something else differs. changed: a primary field
// differs, or a generic call (rewrite, refine). unpredicted: no prediction.
// A policy with a field marked inLine "option" (triage's scope: the call is a
// shape, Antifeed PM, 2026-10-29): the option Nil started from (or none) is
// compared as a primary field with the Premove's option, the option whose
// text the Premove holds (or none); the text itself then counts as an edit.
export function outcome(
  prediction: Prediction | null,
  call: Call,
  generic: Generic | undefined,
  answer: AnswerSchema,
  primary: string[],
  packet: Packet | null,
  derived: Record<string, (call: Call, packet: Packet | null) => string | null> = {},
  option?: string,
  // A loop-kind card (Antifeed PM, 2026-10-30): no shape rule, and only these
  // fields count (choice and priority); title and scope ride with the pick.
  only?: string[],
): Outcome {
  if (!prediction) return "unpredicted";
  if (generic) return "changed";
  // A packet whose options carry no such text (one from before the shapes) compares as before.
  const shapeKeys = only ? [] : Object.keys(answer).filter((k) => answer[k].inLine === "option" && (packet?.options ?? []).some((o) => typeof o.fill[k] === "string"));
  // A decide with no option (an older page): Nil's option is the one whose texts his call holds.
  if (shapeKeys.length && premoveOption(prediction.call, packet, shapeKeys) !== (option ?? premoveOption(call, packet, shapeKeys))) return "changed";
  const fields = only ?? Object.keys(answer).filter((k) => k !== "note");
  // A derived value (slice 7) is made from each call and compared as a field.
  const value = (c: Call, k: string) => (derived[k] ? derived[k](c, packet) : c[k]);
  const differs = (k: string) => norm(value(prediction.call, k)) !== norm(value(call, k));
  if (primary.some(differs)) return "changed";
  const draftEdited = [...drafts(packet?.blocks ?? [])].some(([k, text]) => call[k] !== undefined && call[k] !== text);
  // A note an option filled in is the option's, not Nil's edit.
  const note = (call.note ?? "").trim();
  const optionNote = (packet?.options ?? []).some((o) => (o.fill.note ?? "").trim() === note);
  if (fields.some(differs) || (note !== "" && !optionNote) || draftEdited) return "edited";
  return "matched";
}

// The option whose texts (the inLine "option" fields) a Premove's call holds.
export function premoveOption(call: Call, packet: Packet | null, keys: string[]): string | null {
  return (packet?.options ?? []).find((o) => keys.every((k) => typeof o.fill[k] === "string" && o.fill[k] === call[k]))?.id ?? null;
}

export const lineId = (decidedEventId: string) => `d_${decidedEventId.replace(/^e_/, "")}`;

type CardTrack = { policy: string; project: string; subject?: string; meta: CardMeta; packets: Map<number, Packet>; predictions: Map<number, Prediction | null> };

// The decision log as a function of the events, in log order.
export function linesFromEvents(events: readonly Event[]): (DecisionLine | UndoLine)[] {
  const cards = new Map<string, CardTrack>();
  const out: (DecisionLine | UndoLine)[] = [];
  for (const e of events) {
    if (e.type === "precedent.imported") {
      out.push(...(e.data.lines as DecisionLine[]).map((l) => ({ ...l, imported: true })));
      continue;
    }
    if (!e.card) continue;
    if (e.type === "card.opened") {
      cards.set(e.card, { policy: e.data.policy, project: e.project ?? "", subject: e.subject, meta: e.data.meta, packets: new Map(), predictions: new Map() });
      continue;
    }
    const c = cards.get(e.card);
    if (!c) continue;
    if (e.type === "card.packet") c.packets.set(e.data.version, e.data.packet);
    // A late answer after Nil saw the stand-in is not the Premove (DESIGN.md
    // 13.1): the line keeps the stand-in, as the card does.
    else if (e.type === "card.predicted" && !(e.data.late && e.data.seen && !e.data.afterDecide)) c.predictions.set(e.data.version, e.data.prediction ?? null);
    else if (e.type === "card.decided") {
      const d = e.data;
      const packet = c.packets.get(d.version) ?? null;
      out.push({
        id: lineId(e.id),
        at: e.at,
        policy: c.policy,
        project: c.project,
        card: e.card,
        version: d.version,
        subject: c.subject,
        snapshot: {
          question: packet?.question ?? "",
          blocks: packet?.blocks ?? [],
          options: packet?.options ?? [],
          recommended: packet?.recommended ?? null,
          meta: c.meta,
        },
        prediction: c.predictions.get(d.version) ?? null,
        call: d.call,
        ...(d.generic ? { generic: d.generic } : {}),
        by: e.by,
        outcome: d.outcome ?? null,
        note: d.call?.note ?? "",
        shownAt: d.shownAt ?? null,
        secondsToDecide: d.shownAt ? Math.max(0, (Date.parse(e.at) - Date.parse(d.shownAt)) / 1000) : null,
      });
    } else if (e.type === "card.undone") out.push({ id: `u_${e.id.replace(/^e_/, "")}`, at: e.at, undoes: lineId(e.data.decision) });
  }
  return out;
}

export const isUndo = (l: DecisionLine | UndoLine): l is UndoLine => "undoes" in l;

export class DecisionLog {
  readonly file: string;
  private lines: (DecisionLine | UndoLine)[] = [];
  // Set at load when the file did not match the events and was rebuilt.
  rebuilt = false;

  constructor(dir: string) {
    this.file = join(dir, "decisions.jsonl");
  }

  // Checks the file against the events; rewrites it when a line is missing,
  // doubled or different.
  load(events: readonly Event[]): void {
    this.lines = linesFromEvents(events);
    const want = this.lines.map((l) => JSON.stringify(l)).join("\n") + (this.lines.length ? "\n" : "");
    const have = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
    if (have !== want) {
      writeFileSync(`${this.file}.tmp`, want);
      renameSync(`${this.file}.tmp`, this.file);
      this.rebuilt = have !== "" || want !== "";
    }
  }

  // Called after a batch is on disk, with that batch's events.
  add(batch: readonly Event[], all: readonly Event[]): void {
    if (!batch.some((e) => e.type === "card.decided" || e.type === "card.undone" || e.type === "precedent.imported")) return;
    const fresh = linesFromEvents(all).slice(this.lines.length);
    if (!fresh.length) return;
    appendFileSync(this.file, fresh.map((l) => JSON.stringify(l)).join("\n") + "\n");
    this.lines.push(...fresh);
  }

  all(): readonly (DecisionLine | UndoLine)[] {
    return this.lines;
  }

  // Decision lines that no Undo took back.
  live(): DecisionLine[] {
    const undone = new Set(this.lines.filter(isUndo).map((l) => l.undoes));
    return this.lines.filter((l): l is DecisionLine => !isUndo(l) && !undone.has(l.id));
  }

  // What a predictor of one policy reads: that policy's calls by a human,
  // newest first, decided before `before`. The author's recommendation and an
  // imported line's proposal are removed, so the predictor does not learn to
  // copy the author.
  precedent(policy: string, before?: string): DecisionLine[] {
    return this.live()
      .filter((l) => l.policy === policy && l.by.startsWith("human:") && (!before || l.at < before))
      .map((l, i) => ({ l, i }))
      // Newest first by time; lines of the same time keep the log's order, newest first.
      .sort((a, b) => b.l.at.localeCompare(a.l.at) || b.i - a.i)
      .map(({ l }) => l)
      .map((l) => {
        const { proposal: _p, ...snap } = l.snapshot as DecisionLine["snapshot"] & { proposal?: unknown };
        return { ...l, snapshot: { ...snap, recommended: null } };
      });
  }
}
