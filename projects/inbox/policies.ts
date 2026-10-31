// Nil's Inbox (DESIGN.md section 14): his asks and pages in the office come
// into the queue as cards, and his calls go back through the office. An
// office feature, not the isomux SDLC, so it goes live without triage.
import { WALKTHROUGH } from "../../src/config";
import type { CommandRec } from "../../src/engine";
import { ACCESS_OFF, OWNERLESS, refused } from "../../src/inbox";
import { tokenError } from "../../src/office";
import { Blocked, definePolicies, type RunContext } from "../../src/policies";
import { ask, NOT_SENT_CLOSED } from "./ask";
import { page } from "./page";
import { walkthroughPremove } from "./walkthrough";

// A 403: with a live owner agent (GET /agents answers) Nil's Inbox access
// is off, else the app has no live owner agent. Either holds until someone
// fixes it, so the failure is Blocked: its card offers no retry.
async function why403(err: unknown, ctx: RunContext, pages: boolean): Promise<Error> {
  // Part N: no API token of Nil's, or the office refused it: the words name the token.
  if (tokenError(err)) return new Blocked((err as Error).message);
  if (!refused(err)) return err as Error;
  if (pages) return new Blocked(OWNERLESS);
  try {
    await ctx.office.agents();
    return new Blocked(ACCESS_OFF);
  } catch (e) {
    return refused(e) ? new Blocked(OWNERLESS) : (err as Error);
  }
}

// A busy ask: 3 tries, 2 s apart.
const BUSY_TRIES = 3;
const BUSY_MS = 2000;

export default definePolicies({
  project: "inbox",
  // The name the page shows (round q1 P2): "Project: Inbox".
  name: "Inbox",
  actors: [
    // The app itself, with its app token: it answers asks and acks pages.
    { id: "office", kind: "code", handler: "office" },
    { id: "nil", kind: "human", member: "Nil" },
    // The walkthrough copy's stub plays a consult. The office app has none for
    // the Inbox for now (Antifeed PM, 2026-10-28): each project has its own
    // consult in its room, and an ask's consult would be the one of the
    // asking agent's room, a routing not built while the Inbox reads no asks.
    // So the stand-in makes each ask's Premove.
    ...(WALKTHROUGH ? [{ id: "consult", kind: "code" as const, handler: "walkthrough-stub" }] : []),
  ],
  ...(WALKTHROUGH ? { consult: "consult" } : {}),
  sources: [{ id: "inbox", kind: "isomux-inbox" }],
  events: {
    "inbox.ask.opened": { from: "inbox", what: "an ask for you in the office" },
    "inbox.ask.changed": { from: "inbox", what: "an ask its agent changed" },
    "inbox.ask.closed": { from: "inbox", what: "an ask that left the office: answered in the Inbox or taken back" },
    "inbox.page.opened": { from: "inbox", what: "a page for you in the office" },
    "inbox.page.changed": { from: "inbox", what: "a page raised again, with new words or a new count" },
    "inbox.page.closed": { from: "inbox", what: "a page acked, resolved or gone in the office" },
  },
  policies: [ask, page],
  run: {
    // A 404 from the office (the ask closed between the last read and the
    // send) is done with notSent, not a failure (DESIGN.md 14.4).
    async office(k: CommandRec, ctx: RunContext) {
      const p = k.params as { askId?: string; how?: "reply" | "dismiss" | "file-task"; text?: string; pageId?: string };
      if (k.type === "inbox.ack") {
        const r = await ctx.office.ackPage(String(p.pageId)).catch(async (err) => Promise.reject(await why403(err, ctx, true)));
        return r === "ok" ? { acked: true } : { notSent: "The page was already acked or resolved in the office." };
      }
      // 409 ask_busy: another answer (from the Isomux Inbox) is going out
      // now, and the office refused this one, so a new try sends it once at
      // most. Mostly the ask then closes, and the next try finds it gone.
      for (let i = 0; ; i++) {
        const r = await ctx.office.answerAsk(String(p.askId), p.how ?? "reply", p.text ?? "").catch(async (err) => Promise.reject(await why403(err, ctx, false)));
        if (r === "ok") return { sent: true };
        if (r === "gone") return { notSent: NOT_SENT_CLOSED };
        if (i === BUSY_TRIES - 1) throw new Error("the office was sending another answer to this ask, so it refused yours; it was not sent");
        await Bun.sleep(BUSY_MS);
      }
    },
    "walkthrough-stub": (k: CommandRec, ctx: RunContext) => {
      const c = k.card ? ctx.card(k.card) : undefined;
      const prediction = c?.packet ? walkthroughPremove(c.packet) : null;
      return prediction ? { prediction } : { skip: true };
    },
  },
});
