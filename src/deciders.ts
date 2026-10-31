// Deciders (DESIGN.md section 2.1). A Decider is an interface; the config
// kinds below are the ones the app builds. Every policy with a decider runs
// as `nil` until Nil's policy.decider.set event says otherwise.

import type { Handler } from "./policies";
import type { Card, DecisionLine, DeciderConfig, DeciderStep, Prediction } from "./types";

export interface Decider {
  id: string;
  // signal: aborted when the engine stops waiting (the timeout); a run must stop then.
  decide(card: Card, policyState: unknown, precedent: DecisionLine[], signal?: AbortSignal): Promise<DeciderStep>;
}

// Builds the agent decider (a claude -p run in slice 5; a fake in tests).
export type AgentFactory = (config: Extract<DeciderConfig, { kind: "agent" }>, policy: string) => Decider;

export type DeciderRuntime = { handlers: Record<string, Handler>; agent: AgentFactory };

const asPrediction = (s: DeciderStep): Prediction | null => s.prediction ?? null;

export function build(config: DeciderConfig, policy: string, rt: DeciderRuntime): Decider {
  switch (config.kind) {
    case "code": {
      const h = rt.handlers[config.handler];
      return { id: `code:${config.handler}`, decide: async (card, state, precedent) => h({ card, state, precedent }) };
    }
    case "agent":
      return rt.agent(config, policy);
    case "consult":
      // The consult agent answers a predict command; the engine never builds it as a run.
      throw new Error("the consult agent predicts through its predict command");
    case "nil": {
      const predictor = config.predictor ? build(config.predictor, policy, rt) : null;
      return {
        id: `nil${predictor ? `+${predictor.id}` : ""}`,
        // Nil decides; the predictor's call, whatever it says, is only the Premove.
        decide: async (card, state, precedent, signal) => ({ kind: "ask", prediction: predictor ? asPrediction(await predictor.decide(card, state, precedent, signal)) : null }),
      };
    }
    case "threshold": {
      const agent = build(config.agent, policy, rt);
      return {
        id: `threshold(${agent.id}, ${config.min})`,
        decide: async (card, state, precedent, signal) => {
          const p = asPrediction(await agent.decide(card, state, precedent, signal));
          if (p && p.confidence >= config.min) return { kind: "decided", prediction: p };
          return { kind: "ask", prediction: p };
        },
      };
    }
  }
}

// What runs before Nil's switch: nil, with the file's decider as the
// predictor (its agent, for threshold), so the Premove and calibration exist
// before Nil decides to switch.
export function startConfig(fileConfig: DeciderConfig): DeciderConfig {
  switch (fileConfig.kind) {
    case "nil":
      return fileConfig;
    case "threshold":
      return { kind: "nil", predictor: fileConfig.agent };
    default:
      return { kind: "nil", predictor: fileConfig };
  }
}

// The configs Nil may switch to: nil (as it starts), and, when the file
// allows automatic decisions, the file's decider. For threshold, Nil sets min.
export function allowedSwitch(fileConfig: DeciderConfig, autoAllowed: boolean, wanted: DeciderConfig): string | null {
  const start = startConfig(fileConfig);
  if (JSON.stringify(wanted) === JSON.stringify(start)) return null;
  if (!autoAllowed) return "this policy does not allow automatic decisions (autoAllowed is false)";
  if (fileConfig.kind === "threshold" && wanted.kind === "threshold") {
    if (JSON.stringify(wanted.agent) !== JSON.stringify(fileConfig.agent)) return "the threshold must use the file's agent";
    if (!(wanted.min > 0 && wanted.min <= 1)) return "min must be in (0, 1]";
    return null;
  }
  if (JSON.stringify(wanted) === JSON.stringify(fileConfig)) return null;
  return "the switch offers only nil or the decider the policies file names";
}
