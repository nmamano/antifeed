// The walkthrough copy's Wall Game board (DESIGN.md 16.7): a fake board
// seeded with a task of each shape, Wall Game PM in the roster, and a code
// stub that plays Wall Game Consult's Premove on two of the tasks. Never used
// on the office app.
import type { FakeInbox } from "../../src/fake-inbox";
import type { Task } from "../../src/office";
import type { Packet, Prediction } from "../../src/types";

const ROOM = "51c2d889";

export function seedBoard(f: FakeInbox): void {
  f.roster.push({ id: "agent-0000000000002-aaab", name: "Wall Game PM", roomId: ROOM, roomName: "Wall Game" });
  const task = (t: Partial<Task> & { title: string }) => f.addTask({ createdBy: "Wall Game PM", ...t, roomId: ROOM });
  // Gets a card: Nil's report starts the description, but it holds no call word.
  task({ title: "The campaign level list shows the old stars after a win", priority: "P2", description: "Nil, 2026-07-29: after beating a campaign level, going back to the level list shows the stars from before the win until a reload.\n\nThe list reads a cached copy of the progress." });
  task({ title: "Move the old Wallwars site off Fly", priority: "P1", description: "The old site barely gets played. Move it to the same host as the new one and shut the Fly app down.\n\nNeeds a deploy and a DNS change." });
  task({ title: "Puzzle of the day: a share button", priority: "P3", description: "A share button under the solved puzzle, with the move count and no spoilers." });
  // Gets a card: a long status log as its description, as task d9ff7318 on
  // the live board (round Q1, C8: the packet shows its start, and the rest is
  // behind "Full packet").
  task({ title: "The engine moves to the server", priority: "P1", description: LONG_STATUS });
  // Gets a card: no priority yet.
  task({ title: "Daily video: post to a second account", priority: null, description: "The daily video pipeline posts to one account. A second one doubles the reach for the same render." });
  // No card: claimed.
  task({ title: "The strongest bot resigns in won positions", priority: "P0", assignee: "Wall Game Worker 3", description: "Seen twice in live games this week." });
  // No card: in progress.
  task({ title: "Animal cycle, stage 3", priority: "P2", status: "in_progress", assignee: "Wall Game Worker 1", description: "The plan is in the cycle folder." });
  // No card: Nil's call line is on it.
  task({ title: "An old leaderboard idea", priority: "P3", description: "Nil, 2026-10-20: backlog. Not before the season ends.\n\nWeekly leaderboards per bot." });
}

// The stub's Premove for two seeded tasks; the rest go to the stand-ins.
export function walkthroughPremove(p: Packet): Omit<Prediction, "by" | "precedent"> | null {
  if (p.question.startsWith("The campaign level list"))
    return { call: { choice: "go", priority: "P2" }, confidence: 0.72, why: "A small bug Nil found himself, in the main path of new players.", against: "A reload fixes it, so it may wait behind the bot work.", };
  if (p.question.startsWith("Move the old Wallwars site"))
    return { call: { choice: "design", priority: "P1" }, confidence: 0.6, why: "A move with a deploy and a DNS change: Nil wants the plan first.", against: "The task already says what to do; go would save a round." };
  return null;
}

// About 6,000 characters of status notes, one paragraph per day, with line
// breaks inside them, as a board task's log reads.
const LONG_STATUS = [
  "STATUS 2026-08-09 (Wall Game PM): the engine moves to the server. This reverses the client-side plan of 2026-08-05.\nThe client keeps a thin copy for the move preview only.",
  ...Array.from({ length: 14 }, (_, i) =>
    `STATUS 2026-08-${String(10 + i).padStart(2, "0")} (Wall Game Worker ${(i % 3) + 1}): step ${i + 1} of the move. The worker ported the move list, the wall checks and the clock to the server,\nran the bot ladder against the old engine (no difference in ${200 + i * 10} games), and left the old path behind a flag.\nOpen points: the replay format, the reconnect after a deploy, and the latency on a slow phone. The plan file has the details for each point and the numbers from the run.`),
].join("\n\n");
