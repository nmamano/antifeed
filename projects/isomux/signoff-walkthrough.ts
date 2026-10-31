// Part J's end-to-end check (Antifeed PM, 2026-10-30): sign-off alone, on a
// walkthrough copy, against a Loop app copy at ANTIFEED_LOOP_URL. The check
// posts the Scout's packets itself (its prepare goes to the fake office).
import { definePolicies } from "../../src/policies";
import { signoffParts } from "./signoff";

const so = signoffParts(true);
export default definePolicies({
  project: "isomux",
  actors: [{ id: "nil", kind: "human", member: "Nil" }, ...so.actors],
  sources: so.sources,
  events: so.events,
  policies: so.policies,
  handlers: so.handlers,
  run: so.run,
  agents: so.agents,
});
