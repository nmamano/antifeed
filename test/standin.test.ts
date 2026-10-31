// The code stand-in gives a whole call, one that passes the check as Nil's
// call does (slice 7 walk, 2026-10-26: an ask's stand-in was an empty call).
import { describe, expect, test } from "bun:test";
import { codeVote, safeDefault } from "../src/standin";
import { checkCall } from "../src/validate";
import { ask, packetOf } from "../projects/inbox/ask";
import type { AskData } from "../src/inbox";
import type { Call, Card, DecisionLine, Packet } from "../src/types";

const data = (options: string[], recommended?: string): AskData => ({
  prompt: "Restart the stuck nightly backup now?", agentId: "agent-w", agentName: "Demo Worker", roomName: "Demo", createdAt: 0, updatedAt: 0, editFiles: 0, files: [],
  ...(options.length ? { options } : {}), ...(recommended ? { recommended } : {}),
});
const card = (packet: Packet): Card => ({ id: "c1", kind: "decision", policy: "ask", project: "inbox", version: 1, state: "predicting", packet, meta: { source: "Isomux Inbox", raw: "", author: null, openedAt: "" }, prediction: null, predicted: false, shown: [] }) as unknown as Card;
let n = 0;
const line = (call: Call): DecisionLine => ({
  id: `d${++n}`, at: "2026-10-20T10:00:00.000Z", policy: "ask", project: "inbox", card: `c${n}`, version: 1,
  snapshot: { question: "Restart the stuck nightly backup now?", blocks: [], options: [], recommended: null, meta: { source: "Isomux Inbox", raw: "", author: null, openedAt: "" } },
  prediction: null, call, by: "human:Nil", outcome: "unpredicted", note: "", shownAt: null, secondsToDecide: null,
});
const fits = (c: Card, call: Call) => checkCall(ask.answer!, call, undefined, c.packet) ?? ask.validate?.(call) ?? null;

const OPTIONS: [string, string[], string | undefined][] = [
  ["no options", [], undefined],
  ["1 option (shown as text)", ["Restart it"], "Restart it"],
  ["2 options, a pick", ["Clear it and restart", "Only restart"], "Clear it and restart"],
  ["3 options, no pick", ["Clear it and restart", "Only restart", "Leave it"], undefined],
  ["4 options, a pick", ["A", "B", "C", "D"], "C"],
  ["5 options (shown as text)", ["A", "B", "C", "D", "E"], "B"],
];
const PAST: [string, Call[]][] = [
  ["no past calls", []],
  ["3 past replies", [{ action: "reply", text: "x" }, { action: "reply", text: "y" }, { action: "reply", text: "z" }]],
  ["3 past dismisses", [{ action: "dismiss", text: "" }, { action: "dismiss", text: null }, { action: "dismiss", text: "no" }]],
  ["3 past filed tasks", [{ action: "file-task", text: null }, { action: "file-task", text: "later" }, { action: "file-task", text: "" }]],
  ["mixed, reply first", [{ action: "reply", text: "a" }, { action: "reply", text: "b" }, { action: "dismiss", text: "" }, { action: "file-task", text: null }]],
];

describe("code stand-in on an ask", () => {
  for (const [oname, opts, rec] of OPTIONS)
    for (const [pname, past] of PAST)
      test(`${oname}, ${pname}: a whole call that passes the check`, () => {
        const c = card(packetOf(data(opts, rec)));
        const v = codeVote(ask, c, past.map(line));
        expect(Object.keys(v.call).length).toBeGreaterThan(0);
        expect(fits(c, v.call)).toBeNull();
      });

  test("the author's pick keeps its words", () => {
    const c = card(packetOf(data(["Clear it and restart", "Only restart"], "Only restart")));
    const v = codeVote(ask, c, []);
    expect(v).toMatchObject({ basis: "author", call: { action: "reply", text: "Only restart" } });
  });

  test("a vote for reply takes the words of the author's pick, and says so", () => {
    const c = card(packetOf(data(["Clear it and restart", "Only restart"], "Only restart")));
    const v = codeVote(ask, c, PAST[1][1].map(line));
    expect(v).toMatchObject({ basis: "vote", call: { action: "reply", text: "Only restart" }, confidence: 1 });
    expect(v.why).toContain("The words are the author's pick (option B): the number backs reply, not the words.");
  });

  test("with no author's pick, a vote for reply does not borrow an option's words", () => {
    const c = card(packetOf(data(["Monday", "Tuesday", "Wednesday"])));
    expect(codeVote(ask, c, PAST[1][1].map(line))).toMatchObject({ basis: "none", call: ask.fallback });
  });

  test("when the most voted call cannot be made whole: no basis and the safe default, never a less voted call (PM, 2026-10-26)", () => {
    for (const opts of [[], ["Monday", "Tuesday", "Wednesday"]]) {
      const v = codeVote(ask, card(packetOf(data(opts))), PAST[4][1].map(line));
      expect(v).toMatchObject({ basis: "none", call: ask.fallback, confidence: 0 });
      expect(v.why).toBe("No basis: 2 of the 4 most similar past cards got reply, but a vote cannot fill that call whole for this card, and the author named no pick.");
    }
    // A tie at the most votes: a whole call among the tied ones is the vote's call.
    const tie = [...PAST[4][1], { action: "dismiss", text: "" }];
    expect(codeVote(ask, card(packetOf(data([]))), tie.map(line))).toMatchObject({ basis: "vote", call: { action: "dismiss" } });
  });

  test("Against and the reason use the page's words for a value: file as a task, not file-task", () => {
    const c = card(packetOf(data(["Clear it and restart", "Only restart"], "Only restart")));
    const past = [...PAST[1][1], { action: "file-task", text: null }];
    expect(codeVote(ask, c, past.map(line)).against).toBe("1 of them got file as a task.");
    expect(codeVote(ask, card(packetOf(data([]))), PAST[3][1].map(line)).why).toBe("3 of the 3 most similar past cards got this call.");
    const v = codeVote(ask, card(packetOf(data([]))), [...PAST[3][1], ...PAST[1][1]].map(line));
    expect(v.against).toBe("3 of them got reply.");
  });

  test("with 1 or 2 past calls there is no vote: the author's pick, else no basis, each saying why", () => {
    const two = PAST[1][1].slice(0, 2).map(line);
    expect(codeVote(ask, card(packetOf(data(["A", "B"], "B"))), two).why).toBe("The author's pick: there are too few past calls to vote with yet.");
    expect(codeVote(ask, card(packetOf(data([]))), two)).toMatchObject({ basis: "none", why: "No basis: there are too few past calls to vote with yet, and the author named no pick." });
  });

  test("the safe default is the policy's fallback, never an empty call", () => {
    expect(safeDefault(ask)).toMatchObject({ basis: "none", call: { action: "file-task", text: null } });
  });
});
