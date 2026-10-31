// Nil's input that becomes a task (round q1, I; Nil, 2026-10-28: "Antifeed
// needs a place where I can input stuff that becomes tasks"). The app files
// his words as an untagged task on the target's room board, then tells the
// target's PM agent, and logs how each office write went. Each write goes
// once: POST /api/tasks takes no idempotency key, so a send that may have
// gone out is never sent again on its own (Nil checks the board first).
// Antifeed PM, 2026-10-29: Nil's go for these two writes, only on this path.
import type { Engine, InputRec } from "./engine";
import { nullOffice, type Office } from "./office";
import { WALLGAME_PM_ID, WALLGAME_ROOM } from "../projects/wallgame/policies";

// Where an input can go: a room's board and its PM agent, by id (an agent
// renamed or moved still gets it; a gone one is a 404).
export type InputTarget = { id: string; name: string; roomId: string; pm: { id: string; name: string } };
export const INPUT_TARGETS: InputTarget[] = [
  { id: "antifeed", name: "Antifeed", roomId: "05da3a44", pm: { id: "agent-0000000000004-aaad", name: "Antifeed PM" } },
  { id: "isomux", name: "isomux", roomId: "e6818e47", pm: { id: "agent-0000000000001-aaaa", name: "Isomux PM" } },
  { id: "wallgame", name: "Wall Game", roomId: WALLGAME_ROOM, pm: { id: WALLGAME_PM_ID, name: "Wall Game PM" } },
];

// The task's title: the whole first line of his words.
export function inputTitle(text: string): string {
  // The whole first line, never cut (Nil, 2026-10-30); POST /api/tasks has no title limit.
  return text.trim().split("\n")[0].trim();
}

export class InputSender {
  constructor(
    private engine: Engine,
    private office: Office,
    // Part K: the server path of a stored screenshot, for the Curator to read.
    private blobPath: (name: string) => string | null = () => null,
  ) {}

  // The task's description: who filed it first (Antifeed PM: the board reader
  // sees it first), where Nil wrote it, then his words.
  description(r: InputRec, words: string): string {
    const c = r.card ? this.engine.cards.get(r.card) : undefined;
    const where = (r.page ? ` on its ${r.page.charAt(0).toUpperCase() + r.page.slice(1)} page` : "") + (c ? `, about packet ${c.id} ("${c.packet?.question ?? c.subject ?? ""}")` : "");
    // Part K: one line per screenshot at the end, its absolute server path (the Curator's rule reads it).
    const shots = (r.images ?? []).map((n) => `Screenshot: ${this.blobPath(n) ?? n}`);
    return `Filed by Antifeed for Nil${where}. His words:\n\n${words}${shots.length ? "\n\n" + shots.join("\n") : ""}`;
  }

  async send(id: string): Promise<void> {
    const r = this.engine.inputs.get(id);
    const t = r && INPUT_TARGETS.find((x) => x.id === r.target);
    if (!r || !t) return;
    if (r.state === "sending") {
      if (this.office === nullOffice) return this.engine.inputOutcome(id, { error: "this copy of the app has no office token, so nothing was filed" });
      const words = this.engine.inputText(r);
      try {
        const task = await this.office.createTask({ title: inputTitle(words), description: this.description(r, words), roomId: t.roomId });
        this.engine.inputOutcome(id, { filed: task.id });
      } catch (err) {
        const msg = (err as Error).message;
        // A 4xx never filed it; no answer, a 5xx or a reply with no id may have.
        const refused = /answered 4\d\d\b/.test(msg);
        return this.engine.inputOutcome(id, refused ? { error: "the office refused it", detail: msg } : { error: "the office gave no clear answer", maybe: true, detail: msg });
      }
    }
    await this.tell(id, t);
  }

  // The PM's message, once the task is filed (again on Tell again).
  async tell(id: string, t = INPUT_TARGETS.find((x) => x.id === this.engine.inputs.get(id)?.target)): Promise<void> {
    const r = this.engine.inputs.get(id);
    if (!r || !t || r.state !== "filed" || !r.taskId) return;
    try {
      const n = r.images?.length ?? 0;
      await this.office.message(`Nil filed task ${r.taskId} in your room through Antifeed: "${inputTitle(this.engine.inputText(r))}". The task holds his words${n ? ` and ${n} screenshot${n > 1 ? "s" : ""} (their server paths at the end)` : ""}.`, t.pm.id);
      this.engine.inputOutcome(id, { told: true });
    } catch (err) {
      const msg = (err as Error).message;
      // The page says "Filed, but <PM> is not told: " before these words.
      this.engine.inputOutcome(id, { error: /answered 404\b/.test(msg) ? `the office found no ${t.pm.name}` : /answered 4\d\d\b/.test(msg) ? "the office refused the message" : "the office gave no clear answer", detail: msg });
    }
  }
}
