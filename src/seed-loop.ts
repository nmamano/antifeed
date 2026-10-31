// The triage precedent seed (DESIGN.md section 5): the loop app's applied
// triage decisions, read through its API, as imported decision lines. They
// are precedent only: not in calibration or DPM. The Curator's proposal is
// kept in the snapshot for audit; the precedent reader removes it.

import type { DecisionLine } from "./types";

export const LOOP_API = "http://127.0.0.1:21025";

type LoopItem = {
  taskId: string;
  task: { title: string; description?: string; priority: string | null; createdBy?: string; createdAt: number };
  proposal: Record<string, unknown>;
  proposedAt: number;
  decision: { choice: string; priority: string | null; note: string; decidedAt: number };
};

export function loopLines(items: LoopItem[], policy: string, project: string): DecisionLine[] {
  return items
    .filter((i) => i.decision && Number.isFinite(i.decision.decidedAt))
    .map((i): DecisionLine => {
      const d = i.decision;
      const rewrite = d.choice === "rewrite";
      return {
        id: `d_loop_${i.taskId}_${d.decidedAt}`,
        at: new Date(d.decidedAt).toISOString(),
        policy,
        project,
        card: `loop:${i.taskId}`,
        version: 1,
        subject: i.taskId,
        snapshot: {
          question: i.task.title,
          blocks: i.task.description ? [{ type: "markdown", text: i.task.description.slice(0, 4000) }] : [],
          options: [],
          recommended: null,
          meta: { source: "isomux-loop", author: null, openedAt: new Date(i.proposedAt).toISOString(), raw: `isomux task ${i.taskId}`, ...(i.task.priority ? { priority: i.task.priority } : {}), ...(i.task.createdBy ? { createdBy: i.task.createdBy } : {}) },
          proposal: i.proposal,
        } as DecisionLine["snapshot"],
        prediction: null,
        call: rewrite ? { note: d.note } : { choice: d.choice, priority: d.priority, note: d.note },
        ...(rewrite ? { generic: { kind: "rewrite" as const } } : {}),
        by: "human:Nil",
        outcome: null,
        note: d.note ?? "",
        shownAt: null,
        secondsToDecide: null,
        imported: true,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function fetchLoopItems(base = LOOP_API): Promise<LoopItem[]> {
  // The app starts after this: a loop app that hangs must not hold it.
  const res = await fetch(`${base}/api/items?state=applied`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${base}/api/items answered ${res.status}`);
  return (await res.json()) as LoopItem[];
}
