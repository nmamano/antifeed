import type { Item } from "./policies";
// The demo cards. "asset:<file>" in an image block is replaced by the blob
// name of projects/demo/assets/<file> when the app seeds them.
// The part of both screenshots that needs attention: the Log in button and the footer links.
const FOOTER = { x: 0.03, y: 0.81, w: 0.94, h: 0.175 };
export const seed: Item[] = [
  {
    id: "demo-1",
    policy: "demo-triage",
    walk: "agent",
    meta: { source: "demo board", priority: "P2", effort: "S", createdBy: "Demo Worker" },
    premove: { call: { choice: "go", priority: "P1" }, confidence: 0.82, why: "A visible bug on the sign-in screen that hides Terms and Privacy; your criteria raise sign-in bugs.", against: "Only phones under 340 px wide show it; it may wait for the layout rework." },
    packet: {
      question: "The Log in button covers the footer links on narrow phones",
      blocks: [
        { type: "markdown", text: "On a 320 px wide screen the **Log in** button sits on top of Terms, Privacy and Help, so a person cannot tap them.\n\nThe fix keeps the button in the page flow (one CSS rule)." },
        { type: "image", blob: "asset:before.png", caption: "Before: the button covers the footer", pair: { name: "The sign-in footer", side: "before" }, focus: FOOTER },
        { type: "image", blob: "asset:after.png", caption: "After: the footer shows under the button", pair: { name: "The sign-in footer", side: "after" }, focus: FOOTER },
        { type: "fields", rows: [["Filed by", "Demo Worker"], ["Filed", "3 days ago"], ["Effort", "S: one CSS rule and a screenshot test"]] },
        { type: "fold", title: "Evidence: the diff", blocks: [{ type: "image", blob: "asset:before.png", caption: "The screen before the fix, at full size" }, { type: "diff", path: "src/signin.css", unified: "@@ -12,5 +12,5 @@ .signin footer {\n .signin .login {\n-  position: absolute;\n-  bottom: 22px;\n+  position: static;\n+  margin: 0 16px 12px;\n   height: 44px;\n }" }] },
      ],
    },
  },
  {
    id: "demo-2",
    policy: "demo-triage",
    walk: "informed",
    meta: { source: "demo board", priority: "P3", effort: "M", createdBy: "Demo PM" },
    premove: { call: { choice: "backlog", priority: null }, confidence: 0.64, why: "A nice-to-have feature, and the packet names no member who asked for it; your criteria send those to the backlog.", against: "If members did ask for it, your criteria raise it." },
    packet: {
      question: "Add a dark theme switch to Settings",
      blocks: [{ type: "markdown", text: "The app follows the system theme today. This adds a switch in Settings with three values: system, light, dark." }],
    },
  },
  {
    id: "demo-3",
    policy: "demo-design",
    walk: "claude",
    meta: { source: "Demo Worker 2", priority: "P1", effort: "M" },
    premove: { call: { choice: "go", priority: "P1" }, confidence: 0.55, why: "Option B is the smallest change that keeps a closed task's card out of the queue.", against: "Option C is closer to how the board already works." },
    packet: {
      question: "What does the queue do with a card whose task closed?",
      blocks: [{ type: "markdown", text: "A task can close while its card waits. Today the card stays until someone opens it." }],
      options: [
        { id: "a", label: "A. Leave it; the card says the task closed", cost: "No code", fill: { choice: "go", priority: "P2", note: "A: leave it, mark it closed" } },
        { id: "b", label: "B. Withdraw it at the next board read", cost: "S: about an hour", fill: { choice: "go", priority: "P1", note: "B: withdraw at the next read" } },
        { id: "c", label: "C. Withdraw it and file a note on the task", cost: "M: half a day", fill: { choice: "go", priority: "P2", note: "C: withdraw and note it" } },
      ],
      recommended: "b",
    },
  },
  {
    id: "demo-4",
    policy: "demo-reply",
    walk: "agent",
    meta: { source: "demo email", createdBy: "Demo Support" },
    premove: { call: { choice: "send" }, confidence: 0.71, why: "A plain date question, and the date is final: the release check passed this morning. Your criteria answer these the same day.", against: "A late bug can still move a release; the draft says \"we plan\", but the member may plan on Thursday." },
    packet: {
      question: "A member asks when the next release ships",
      blocks: [
        { type: "markdown", text: "**Their question:** \"Is the new version out this week? I want to plan the upgrade.\"\n\nThe release check passed this morning, so Thursday is the final date." },
        { type: "draft", key: "reply", text: "Hi, we plan to release on Thursday. I will write again if the date moves." },
      ],
    },
  },
  {
    id: "demo-5",
    policy: "demo-triage",
    walk: "vote",
    meta: { source: "demo board", priority: "P2", createdBy: "Demo Worker" },
    packet: {
      question: "The export file has no header row",
      blocks: [{ type: "markdown", text: "A CSV export opens in a spreadsheet with the first record as the column names, so a member must add the header by hand." }],
    },
  },
  {
    id: "demo-7",
    policy: "demo-triage",
    walk: "late",
    lateMs: 25_000,
    meta: { source: "demo board", priority: "P1", effort: "S", createdBy: "Demo PM" },
    premove: { call: { choice: "backlog", priority: null }, confidence: 0.6, why: "Only slow phones lose the letter, and it is not a sign-in or checkout bug, so your criteria send it to the backlog.", against: "Search runs on every visit, so a lost letter may reach many members." },
    packet: {
      question: "The search box drops the last letter on slow phones",
      blocks: [{ type: "markdown", text: "On a slow phone, typing fast into the search box loses the last letter of the word." }],
    },
  },
  {
    id: "demo-8",
    policy: "demo-reply",
    walk: "late",
    lateMs: 120_000,
    meta: { source: "demo email", createdBy: "Demo Support" },
    premove: { call: { choice: "hold" }, confidence: 0.66, why: "The draft promises a refund date that billing has not set.", against: "The member asked twice; a short answer without a date is better than silence." },
    packet: {
      question: "A member asks when their refund arrives",
      blocks: [
        { type: "markdown", text: "**Their message:** \"I cancelled last week. When does the refund reach my card?\"" },
        { type: "draft", key: "reply", text: "Hi, the refund goes out on Monday and reaches your card in 3 to 5 days." },
      ],
    },
  },
  {
    id: "demo-6",
    policy: "demo-triage",
    action: {
      question: "Approve the sign-in prompt on your phone",
      blocks: [
        { type: "markdown", text: "The deploy agent signs in to the hosting dashboard and needs your second factor." },
        { type: "checklist", items: ["Open the authenticator on your phone", "Approve the prompt that says \"dashboard sign-in\""] },
      ],
    },
  },
];

// The walkthrough copy's fake claude -p stand-in (DESIGN.md 13.4): no spend.
// It answers with the seed's Premove; for a "vote" card it fails, so the
// code vote runs.
export function standinFor(policy: string, text: string) {
  const it = seed.find((x) => x.policy === policy && x.packet && text.includes(x.packet.question));
  if (!it?.premove || it.walk === "vote") throw new Error("in this test copy, the script that plays it has no answer for this card");
  return { ...it.premove, by: "agent:standin@walkthrough-fake" as const };
}
