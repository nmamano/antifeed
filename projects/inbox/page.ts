// Policy `page` (DESIGN.md 14.3): a page for Nil becomes an action card.
// His Done (after its Undo time) acks the page in the office; "Could not do
// it" sends no ack, so the office keeps repeating the page. A page acked in
// the Inbox, resolved by its source or gone withdraws the card, with the
// reason. A policy with no decider: it issues only what the event sets.
import { OFFICE_URL } from "../../src/config";
import type { PageData } from "../../src/inbox";
import type { Block, Event, OutItem, Packet, Policy } from "../../src/types";
import { ptStamp } from "./ask";

export type PageState = {
  // page id -> its action command while the card waits for Nil
  action: Record<string, string>;
  // action command -> its page, and its card
  commandPage: Record<string, string>;
  commandCard: Record<string, string>;
  // page id -> Nil's Done here sent its ack (so an "acked" is his own)
  ackedHere: Record<string, boolean>;
  // page id -> its title and body as the last card had them
  words: Record<string, string>;
};

export const PAGE_REASONS: Record<string, string> = {
  acked: "Acked in the Isomux Inbox, so it no longer waits for you.",
  resolved: "Its source resolved the page, so it no longer waits for you.",
  gone: "The page is gone from the office, so it no longer waits for you.",
};
// The page came again while Nil's Done was held on its earlier card; that Done acked it.
export const PAGE_ACKED_HERE = "Your Done on its earlier card acked the page, so it no longer waits for you.";
export const PAGE_CHANGED = "The page was raised again with new words: a new card has them.";

export function pagePacket(d: PageData): Packet {
  const blocks: Block[] = [];
  if (d.body) blocks.push({ type: "markdown", text: d.body });
  blocks.push({
    type: "fields",
    rows: [
      ...(d.roomName ? ([["Room", d.roomName]] as [string, string][]) : []),
      ["First raised", ptStamp(d.createdAt)],
      ...(d.raiseCount > 1 ? ([["Raised", `${d.raiseCount} times, last at ${ptStamp(d.lastRaisedAt)}`]] as [string, string][]) : []),
    ],
  });
  blocks.push({ type: "markdown", text: "Done acks the page in the office, so it stops repeating. Could not do it leaves it open there." });
  return { question: d.title, blocks };
}

const issuePage = (id: string, d: PageData): OutItem => ({
  issue: {
    type: "inbox.page",
    subject: id,
    params: { pageId: id },
    packet: pagePacket(d),
    meta: { source: "Isomux Inbox", raw: d.agentId ? `${OFFICE_URL}/agents/${d.agentId}` : OFFICE_URL, createdBy: d.sourceName },
  },
});

export const page: Policy<PageState> = {
  id: "page",
  name: "Page",
  color: "#be185d",
  subjectLabel: null,
  actionLabel: "Page for you",
  createdByLabel: "From",
  on: ["inbox.page.opened", "inbox.page.changed", "inbox.page.closed"],
  emits: [],
  commands: {
    "inbox.page": { actor: "nil", delivery: "at-most-once", what: "a page for you", when: "For each new page, and again when its words change", failedWords: "nothing sent; the page stays open in the office" },
    // A second ack is harmless: the office answers it as done.
    "inbox.ack": { actor: "office", delivery: "at-least-once", what: "ack the page in the office", when: "After your Done" },
  },
  init: { action: {}, commandPage: {}, commandCard: {}, ackedHere: {}, words: {} },
  reduce(state, e: Event) {
    const s: PageState = { action: { ...state.action }, commandPage: { ...state.commandPage }, commandCard: { ...state.commandCard }, ackedHere: { ...state.ackedHere }, words: { ...state.words } };
    const wordsOf = (x: PageData) => `${x.title}\n${x.body ?? ""}`;
    const out: OutItem[] = [];
    const d = e.data ?? {};
    // The card of the page's waiting action, to withdraw (the engine cancels its action with it).
    const waiting = (page: string) => (s.action[page] ? s.commandCard[s.action[page]] : undefined);
    switch (e.type) {
      case "inbox.page.opened":
        s.words[e.subject!] = wordsOf(d as PageData);
        if (!s.action[e.subject!]) out.push(issuePage(e.subject!, d as PageData));
        break;
      case "inbox.page.changed": {
        const same = s.words[e.subject!] === wordsOf(d as PageData);
        s.words[e.subject!] = wordsOf(d as PageData);
        const card = waiting(e.subject!);
        // Raised again with the same words: the card shows the new count in
        // place. A card Nil marked (held) stays as he saw it, and its Done acks.
        if (same) {
          if (card) out.push({ repacket: { card, packet: pagePacket(d as PageData) } });
          break;
        }
        // The engine withdraws an action card only while Nil has not marked
        // it: a marked Done goes out as it is, and acks the page.
        if (card) out.push({ withdraw: card, reason: PAGE_CHANGED });
        out.push(issuePage(e.subject!, d as PageData));
        break;
      }
      case "inbox.page.closed":
        if (waiting(e.subject!)) out.push({ withdraw: waiting(e.subject!)!, reason: d.state === "acked" && s.ackedHere[e.subject!] ? PAGE_ACKED_HERE : (PAGE_REASONS[d.state] ?? PAGE_REASONS.gone) });
        delete s.ackedHere[e.subject!];
        break;
      case "command.issued":
        if (d.type === "inbox.page") {
          s.action[e.subject!] = e.command!;
          s.commandPage[e.command!] = e.subject!;
          s.commandCard[e.command!] = d.card;
        }
        break;
      case "command.done":
      case "command.failed":
      case "command.cancelled": {
        const p = s.commandPage[e.command!];
        if (!p) break;
        if (s.action[p] === e.command) delete s.action[p];
        delete s.commandPage[e.command!];
        delete s.commandCard[e.command!];
        // Nil's Done: ack the page. Could not do it: no ack.
        if (e.type === "command.done") {
          s.ackedHere[p] = true;
          out.push({ issue: { type: "inbox.ack", subject: p, params: { pageId: p }, about: { title: "Your Done on a page", rows: [["Page", (s.words[p] ?? "").split("\n")[0]]] } } });
        }
        break;
      }
    }
    return { state: s, out };
  },
};
