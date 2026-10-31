// A fake isomux project for engine tests: a triage policy over board events.
import { definePolicies } from "../../../src/policies";
import { triage } from "./triage";

export default definePolicies({
  project: "isomux",
  actors: [
    { id: "curator", kind: "agent", agentName: "Isomux Curator", skill: "isomux-curator" },
    { id: "nil", kind: "human", member: "Nil" },
  ],
  sources: [{ id: "board", kind: "isomux-board", roomId: "e6818e47" }],
  events: {
    "board.task.seen": { from: "board" },
    "board.task.filed": { from: "board" },
    "board.task.changed": { from: "board" },
    "board.task.closed": { from: "board" },
    "triage.decided": { from: "triage" },
  },
  policies: [triage],
});
