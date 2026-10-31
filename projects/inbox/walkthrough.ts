// The walkthrough copy's Inbox (DESIGN.md 14.5): a fake office seeded with
// asks and pages of each shape, and a code stub that plays Isomux Consult's
// Premove on each ask. Never used on the office app.
import { readFileSync } from "node:fs";
import type { FakeInbox } from "../../src/fake-inbox";
import type { Packet, Prediction } from "../../src/types";

const asset = (name: string) => new Uint8Array(readFileSync(new URL(`../demo/assets/${name}`, import.meta.url)));

export function seedInbox(f: FakeInbox): void {
  f.roster = [
    { id: "agent-demo-worker", name: "Demo Worker", roomId: "room-demo", roomName: "Demo" },
    { id: "agent-demo-lead", name: "Demo Lead", roomId: "room-demo", roomName: "Demo" },
    { id: "agent-demo-ops", name: "Demo Ops", roomId: "room-ops", roomName: "Ops" },
  ];
  f.addAsk(
    {
      agentId: "agent-demo-worker",
      prompt: "Ship the new sign-in footer to every member now, or behind a flag first?\n\nThe fix is one CSS rule (the screenshot shows it on a 320 px screen). A flag costs a day and lets us watch the error rate first.",
      options: ["Ship it to everyone now", "Behind a flag first", "Wait for the redesign"],
      recommended: "Behind a flag first",
      commands: ["bun run deploy --flag signin-footer"],
    },
    [{ name: "after.png", type: "image/png", bytes: asset("after.png") }],
  );
  f.addAsk({
    agentId: "agent-demo-lead",
    prompt: "What should the error say when a member's sign-in link has expired? My draft: \"This link has expired. We sent you a new one.\" Change anything you like.",
  });
  f.addAsk(
    {
      agentId: "agent-demo-ops",
      prompt: "Run the database migration on the staging box tonight?",
      options: ["Run it tonight", "Not yet"],
      editFiles: [{ path: "migrations/0042.sql" }, { path: "migrations/0043.sql" }],
    },
    [{ name: "plan.txt", type: "text/plain", bytes: new TextEncoder().encode("0042: add the expires_at column\n0043: backfill it from created_at\n") }],
  );
  f.raisePage({ title: "The build box disk is 92% full", body: "Builds fail at 95%. Clearing /var/cache/builds frees about 40 GB.", key: "disk", agentId: "agent-demo-ops", agentName: "Demo Ops", roomId: "room-ops" });
  f.raisePage({ title: "Restart the stuck nightly backup", key: "backup", agentId: "agent-demo-lead", agentName: "Demo Lead", roomId: "room-demo" });
}

// The stub's Premove for each seeded ask: the agent's pick, a draft in
// Nil's words, or a filed task.
export function walkthroughPremove(p: Packet): Omit<Prediction, "by" | "precedent"> | null {
  const base = { against: "", why: "" };
  if (p.question.startsWith("Ship the new sign-in footer")) {
    const o = p.options?.find((x) => x.id === p.recommended);
    return o ? { ...base, call: { ...o.fill }, confidence: 0.78, why: "A one-rule fix with a cheap flag: watch the error rate for a day.", against: "The flag costs a day for a change this small; shipping now is also safe." } : null;
  }
  if (p.question.startsWith("What should the error say"))
    return { ...base, call: { action: "reply", text: "Good. Make it: \"This link has expired. Check your email for a new one.\"" }, confidence: 0.6, why: "The draft is close; members should know where the new link is.", against: "The agent's own words may be fine as they are." };
  if (p.question.startsWith("Run the database migration"))
    return { ...base, call: { action: "file-task", text: "Not tonight; after the release." }, confidence: 0.55, why: "A migration the night before a release is a risk with no gain.", against: "Staging only: running it now finds problems earlier." };
  return null;
}
