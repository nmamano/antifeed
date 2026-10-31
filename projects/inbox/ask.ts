// Policy `ask` (DESIGN.md 14.2): an ask of Nil's in the office becomes a
// decision card. The policy writes the packet itself from the ask. Nil's call
// is a reply, a dismiss or a filed task; the office actor sends it after the
// call's Undo time. A reply is Nil's own message to an agent, so this kind
// never leaves Nil (autoAllowed false), and an Undo after the send is refused.
import { OFFICE_URL } from "../../src/config";
import { firstLine } from "../../src/validate";
import { type AskData, type AskFile, officePath } from "../../src/inbox";
import type { Block, Call, Event, OutItem, Option, Packet, Policy } from "../../src/types";

export type AskState = {
  // ask id -> its live card (not withdrawn; its call not sent or dropped)
  card: Record<string, string>;
  // card -> its ask, for every card this policy opened
  cardAsk: Record<string, string>;
  cardState: Record<string, "open" | "decided">;
  // card -> the answer command that is not finished
  answer: Record<string, string>;
  // ask id -> it left the office (answered in the Inbox or taken back)
  gone: Record<string, boolean>;
  // ask id -> its agent and question, for the answer's plain words
  info: Record<string, { agent: string; question: string }>;
};

export const ANSWERS = { reply: "inbox.reply", dismiss: "inbox.dismiss", "file-task": "inbox.file-task" } as const;
export const CLOSED = "Answered in the Isomux Inbox, or taken back by its agent, so it no longer waits for you.";
export const CHANGED = "The agent changed the ask: a new card has its new words.";
export const NOT_SENT_CLOSED = "Not sent: the ask was closed in the office before your call went out.";
export const NOT_SENT_CHANGED = "Not sent: the agent changed the ask before your call went out. The new card has its new words.";

// The time an ask came, in Pacific time (Nil's clock).
// An answer in plain words (CommandAbout): the Status line while it waits,
// and the failed-command card if it fails.
const HOW = { reply: (a: string) => `Your reply to ${a}`, dismiss: (a: string) => `Your dismiss of ${a}'s ask`, "file-task": (a: string) => `Your filed task for ${a}'s ask` };
export function answerAbout(how: keyof typeof ANSWERS, info: { agent: string; question: string } | undefined, text: string) {
  const agent = info?.agent ?? "the agent";
  const rows: [string, string][] = [["Ask", info?.question ?? "(not known)"], ["Agent", agent]];
  if (text.trim()) rows.push([how === "reply" ? "Your words" : "Your reason", text]);
  return { title: HOW[how](agent), rows };
}

export const ptStamp = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

// The prompt's whole first line, never cut (Nil, 2026-10-30); the body keeps the whole prompt.
export function questionOf(prompt: string): string {
  return firstLine(prompt) || "An ask";
}

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const kb = (n?: number) => (n === undefined ? "" : n < 1024 ? ` (${n} bytes)` : ` (${Math.round(n / 1024)} KB)`);

function fileBlocks(files: AskFile[]): Block[] {
  return files.map((f): Block => {
    if (!f.blob) return { type: "markdown", text: `The file **${f.name}** did not load (${f.error ?? "unknown reason"}). The Isomux Inbox shows it.` };
    // At the card's full width: an agent's screenshot is often dense (slice 7 walk).
    if (IMAGE.test(f.mediaType)) return { type: "image", blob: f.blob, caption: f.name, wide: true };
    return { type: "file", blob: f.blob, name: f.name, ...(f.size !== undefined ? { size: f.size } : {}) };
  });
}

export function packetOf(d: AskData): Packet {
  const question = questionOf(d.prompt);
  const blocks: Block[] = [];
  // The whole prompt, as the agent wrote it (data, not orders). When the
  // question is its whole first line, the packet starts after that line.
  const lines = d.prompt.trim().split("\n");
  const rest = lines[0].trim() === question ? lines.slice(1).join("\n").trim() : d.prompt.trim();
  if (rest) blocks.push({ type: "markdown", text: rest });
  // The card's head names the agent; the packet adds where and when.
  blocks.push({ type: "fields", rows: [...(d.roomName ? ([["Room", d.roomName]] as [string, string][]) : []), ["Asked", ptStamp(d.createdAt)]] });
  // The source drops a link that is not an office path; this is the second guard.
  if (d.link && officePath(d.link)) blocks.push({ type: "link", url: OFFICE_URL + d.link, label: `The office page this ask points to (${d.link})` });
  blocks.push(...fileBlocks(d.files));
  if (d.commands?.length) {
    blocks.push({ type: "markdown", text: `The agent attached ${d.commands.length === 1 ? "a command" : `${d.commands.length} commands`} for your terminal. Copy ${d.commands.length === 1 ? "it" : "one"} here, or answer in the Isomux Inbox to put ${d.commands.length === 1 ? "it" : "them"} in its terminal panel.` });
    for (const c of d.commands) blocks.push({ type: "code", text: c });
  }
  if (d.editFiles > 0) blocks.push({ type: "markdown", text: `This ask also opens ${d.editFiles === 1 ? "1 file" : `${d.editFiles} files`} in the editor; answer it in the Isomux Inbox to see ${d.editFiles === 1 ? "it" : "them"}.` });
  const opts = d.options ?? [];
  // The office allows 2 to 4 options (isomux server/asks.ts ASK_OPTIONS_MIN
  // and MAX, read 2026-10-26), as a card does. Any other count is a guard
  // only: it stays text, with the agent's pick named.
  if (opts.length && (opts.length < 2 || opts.length > 4)) blocks.push({ type: "markdown", text: `The agent's options: ${opts.map((o) => `"${o}"${o === d.recommended ? " (its pick)" : ""}`).join(", ")}.` });
  const options: Option[] | undefined = opts.length >= 2 && opts.length <= 4 ? opts.map((o, i) => ({ id: "abcd"[i], label: o, fill: { action: "reply", text: o } })) : undefined;
  const rec = options?.find((o) => o.label === d.recommended)?.id;
  return { question, blocks, ...(options ? { options } : {}), ...(rec ? { recommended: rec } : {}) };
}

// An ask's choice (DESIGN.md 14.2, Antifeed PM 2026-10-26): the label of
// the option whose words the reply sends, or "own words". A dismiss and a
// filed task have none. The outcome compares it with the action; the words
// themselves are secondary.
export function choiceOf(call: Call, packet: Packet | null): string | null {
  if (call.action !== "reply") return null;
  const text = (call.text ?? "").trim();
  return (packet?.options ?? []).find((o) => String(o.fill.text ?? "").trim() === text)?.label ?? "own words";
}

const openCard = (id: string, d: AskData): OutItem => ({
  open: { subject: id, meta: { source: "Isomux Inbox", raw: `${OFFICE_URL}/agents/${d.agentId}`, createdBy: d.agentName }, packet: packetOf(d) },
});

export const ask: Policy<AskState> = {
  id: "ask",
  name: "Ask for you",
  color: "#2f6fde",
  subjectLabel: null,
  createdByLabel: "From",
  // Nil's words go in the reply; a note the agent never reads would mislead.
  noNote: true,
  on: ["inbox.ask.opened", "inbox.ask.changed", "inbox.ask.closed"],
  emits: [],
  commands: {
    "inbox.reply": { actor: "office", delivery: "at-most-once", what: "send your reply to the agent", when: "After your call", only: "if you reply" },
    "inbox.dismiss": { actor: "office", delivery: "at-most-once", what: "dismiss the ask", when: "After your call", only: "if you dismiss it" },
    "inbox.file-task": { actor: "office", delivery: "at-most-once", what: "file the ask as a task", when: "After your call", only: "if you file it as a task" },
  },
  decider: { kind: "nil", predictor: { kind: "consult", criteria: "ask-criteria.md" } },
  // A reply is Nil's own message to an agent: an agent never speaks as Nil (Nil, 2026-10-23).
  autoAllowed: false,
  answer: {
    action: { enum: ["reply", "dismiss", "file-task"], label: "Answer" },
    text: {
      text: { max: 4000 },
      label: "Words",
      help: "A reply sends these words to the agent as your message. With a dismiss or a filed task they go as the reason, and they may stay empty.",
      needs: { action: ["reply"] },
    },
  },
  derived: { choice: choiceOf },
  primary: ["action", "choice"],
  // No basis for a Premove: file it as a task. The office (isomux asks.ts,
  // file-task) puts a task on the board of the agent's room, tells the agent,
  // and closes the ask. Nothing goes out as Nil's own words.
  fallback: { action: "file-task", text: null },
  fallbackHelp: "file as a task: a task on the board of the agent's room, and the ask closes",
  undoUntilSent: "Your answer went to the agent; it cannot be taken back.",
  init: { card: {}, cardAsk: {}, cardState: {}, answer: {}, gone: {}, info: {} },
  reduce(state, e: Event) {
    const s: AskState = { card: { ...state.card }, cardAsk: { ...state.cardAsk }, cardState: { ...state.cardState }, answer: { ...state.answer }, gone: { ...state.gone }, info: { ...state.info } };
    if ((e.type === "inbox.ask.opened" || e.type === "inbox.ask.changed") && e.data?.prompt) s.info[e.subject!] = { agent: e.data.agentName, question: questionOf(e.data.prompt) };
    const out: OutItem[] = [];
    const d = e.data ?? {};
    switch (e.type) {
      case "inbox.ask.opened": {
        // The source drops secret requests; this is the second guard.
        if (d.secret || s.card[e.subject!]) break;
        out.push(openCard(e.subject!, d as AskData));
        break;
      }
      case "inbox.ask.changed": {
        if (d.secret) break;
        const card = s.card[e.subject!];
        if (card && s.cardState[card] === "open") out.push({ withdraw: card, reason: CHANGED });
        else if (card && s.answer[card]) out.push({ cancel: s.answer[card], reason: NOT_SENT_CHANGED });
        out.push(openCard(e.subject!, d as AskData));
        break;
      }
      case "inbox.ask.closed": {
        s.gone[e.subject!] = true;
        const card = s.card[e.subject!];
        if (!card) break;
        if (s.cardState[card] === "open") out.push({ withdraw: card, reason: CLOSED });
        else if (s.answer[card]) out.push({ cancel: s.answer[card], reason: NOT_SENT_CLOSED });
        delete s.card[e.subject!];
        break;
      }
      case "card.opened":
        s.card[e.subject!] = e.card!;
        s.cardAsk[e.card!] = e.subject!;
        s.cardState[e.card!] = "open";
        break;
      case "card.withdrawn": {
        const a = s.cardAsk[e.card!];
        if (a && s.card[a] === e.card) delete s.card[a];
        delete s.cardState[e.card!];
        break;
      }
      case "card.decided": {
        const a = s.cardAsk[e.card!];
        if (!a) break;
        s.cardState[e.card!] = "decided";
        const how = d.call?.action as keyof typeof ANSWERS;
        if (!ANSWERS[how]) break;
        const text = d.call?.text ?? "";
        out.push({ issue: { type: ANSWERS[how], card: e.card, subject: a, params: { askId: a, how, text }, about: answerAbout(how, s.info[a], text) } });
        break;
      }
      case "card.undone": {
        // Only inside the Undo time: after the send the engine refuses the Undo (undoUntilSent).
        const a = s.cardAsk[e.card!];
        s.cardState[e.card!] = "open";
        if (s.answer[e.card!]) out.push({ cancel: s.answer[e.card!] });
        // A card whose ask left the office, or that a newer card of a changed
        // ask replaced, does not come back to the queue.
        if (a && s.gone[a]) out.push({ withdraw: e.card!, reason: CLOSED });
        else if (a && s.card[a] && s.card[a] !== e.card) out.push({ withdraw: e.card!, reason: CHANGED });
        else if (a) s.card[a] = e.card!;
        break;
      }
      case "command.issued":
        if (Object.values(ANSWERS).includes(d.type) && d.card) s.answer[d.card] = e.command!;
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled":
        for (const [c, k] of Object.entries(s.answer))
          if (k === e.command) {
            delete s.answer[c];
            const a = s.cardAsk[c];
            // Sent (or found closed): the ask is done here. A cancel by an Undo
            // left the card open; a cancel because the ask closed or changed
            // already moved the ask on. A failure keeps the card decided; the
            // command-failed card offers the retry.
            if (e.type === "command.done" && a && s.card[a] === c) delete s.card[a];
          }
        break;
    }
    return { state: s, out };
  },
};
