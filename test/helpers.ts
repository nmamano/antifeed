// Test helpers: a temp data dir, a clock the test moves, a fake agent decider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decider } from "../src/deciders";
import { Engine, type EngineOptions } from "../src/engine";
import { folderHash, type LoadedProject } from "../src/policies";
import type { Card, Prediction } from "../src/types";
import fake from "./fixtures/isomux/policies";

// One root folder per test run. Each test file calls afterAll(cleanup); a
// later file makes the root again when it needs it.
let root: string | null = null;
export function cleanup(): void {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
}

export function tempDir(): string {
  root ??= mkdtempSync(join(tmpdir(), "af-test-"));
  return mkdtempSync(join(root, "t-"));
}

export const FIXTURE = join(import.meta.dir, "fixtures/isomux/policies.ts");
export const project = (def = fake): LoadedProject => ({ def, path: FIXTURE, hash: folderHash(FIXTURE) });

export type Fake = {
  calls: Card[];
  signals: (AbortSignal | undefined)[];
  // What the agent answers for a card; default go P2 at 0.8.
  answer: (c: Card) => Partial<Prediction> | "throw" | "hang";
};

export function fakeAgent(): Fake {
  return { calls: [], signals: [], answer: () => ({}) };
}

export const MEMBER = "member-nil";
// A project with its policies in the card kind every other policy has (no
// cardKind): the engine paths a loop-kind card does not show (Nil, 2026-10-30).
export const classic = <T extends { policies: { cardKind?: string }[] }>(def: T): T => ({ ...def, policies: def.policies.map((p) => ({ ...p, cardKind: undefined })) });

export function engine(dir: string, opts: { fake?: Fake; clock?: { t: number }; projects?: LoadedProject[]; predictTimeoutMs?: number; makeLog?: EngineOptions["makeLog"]; predict?: EngineOptions["predict"]; onIssued?: () => void; inputTargets?: string[] } = {}) {
  const fake = opts.fake ?? fakeAgent();
  const clock = opts.clock ?? { t: Date.parse("2026-10-26T16:00:00Z") };
  let n = 0;
  const e = new Engine({
    dir,
    projects: opts.projects ?? [project()],
    now: () => clock.t,
    ids: { next: (p) => `${p}_${String(clock.t)}_${String(n++).padStart(5, "0")}_${Math.random().toString(16).slice(2, 6)}` },
    predictTimeoutMs: opts.predictTimeoutMs ?? 2_000,
    makeLog: opts.makeLog,
    predict: opts.predict,
    onIssued: opts.onIssued,
    inputTargets: opts.inputTargets,
    runtime: {
      agent: (config, policy): Decider => ({
        id: `agent:fake-${policy}`,
        async decide(card, _s, _p, signal) {
          fake.calls.push(card);
          fake.signals.push(signal);
          const a = fake.answer(card);
          if (a === "throw") throw new Error("predictor broke");
          if (a === "hang") return new Promise(() => {});
          const prediction: Prediction = {
            call: { choice: "go", priority: "P2" }, confidence: 0.8, why: "fits the goals", against: "it may be done already",
            by: `agent:predictor@${config.model}#abc123`, precedent: [], ...a,
          };
          return { kind: "ask", prediction };
        },
      }),
    },
  });
  return { e, fake, clock };
}

export const packet = (q = "Triage: fix the login button") => ({ question: q, blocks: [{ type: "markdown" as const, text: "The button overlaps on phones." }], recommended: undefined });

// Files a board task and has the Curator answer the prepare command.
export async function fileAndPrepare(e: Engine, taskId = "t1", priority = "P2") {
  e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: taskId, data: { title: "Fix the login button", priority } });
  const k = [...e.commands.values()].find((c) => c.type === "triage.prepare" && c.subject === taskId && c.state === "issued")!;
  e.postPacket({ command: k.id, packet: packet(), meta: { raw: `board:${taskId}` } });
  await e.settle();
  return [...e.cards.values()].find((c) => c.subject === taskId)!;
}

// A predict runtime for tests (DESIGN.md 13.1): blobs in memory, a fixed
// model, and a stand-in that answers as `standin` says.
export function fakePredict(over: Partial<import("../src/engine").PredictRuntime> = {}) {
  const blobs = new Map<string, string>();
  let n = 0;
  const rt: import("../src/engine").PredictRuntime = {
    input: (policy, criteria, card) => ({ text: `input for ${policy} ${card.id} v${card.version} (${criteria})`, criteriaHash: "crit0001", precedent: [] }),
    putBlob: (t) => {
      const name = `${String(n++).padStart(64, "0")}.txt`;
      blobs.set(name, t);
      return name;
    },
    getBlob: (name) => blobs.get(name) ?? null,
    agentModel: () => "claude-opus-5-5",
    standin: async () => ({ call: { choice: "backlog", priority: null }, confidence: 0.5, why: "stand-in", against: "x", by: "agent:standin@sonnet#s1" }),
    startMs: 120_000,
    answerMs: 600_000,
    ...over,
  };
  return { rt, blobs };
}
