# Antifeed thesis (working name)

Agreed between Nil and Isomux PM on 2026-10-25. Source essay: ESSAY.md. Prior
research and prototypes: ~/nil/loop-app (Research Lab, 2026-10-21 to 10-24).
Where they differ from this file, this file wins.

## The loop

The human decides; repeat until the queue is empty. That is the loop. The app
is the one queue where the human makes every decision that agents cannot
safely predict.

Metric: eDPM, effective decisions per minute. An effective decision is one
where two reasonable humans could disagree, or where there is one correct
answer but a model may not get it right. Both need Nil's judgement (Nil,
2026-10-26). From the decision log, a call is effective when Nil changed or
edited the Premove (the model got it wrong), when the Premove's calibrated
confidence was under 0.9 (the model was unsure), or when the card had no
Premove. A confirm of a Premove at 0.9 or more is not effective: a threshold
decider should take those calls off Nil. Track DPM and eDPM from the decision
log and show them weekly, not as a live counter, so the number does not
become the target. A worse predictor raises eDPM (every miss counts), so eDPM
always shows next to the predictor's match rate.

## Model

Vocabulary is Event Storming / CQRS, with Nil's terms where he has them.

- Event: a past fact ("task filed", "merged at sha X", "Nil decided go P1").
  Anything can subscribe to it.
- Command (Nil: action): imperative, one actor, can fail. Its outcome is an
  event. The actor is part of the command's configuration (an agent, code, or
  Nil). A command whose actor is Nil is an action card (2FA, sudo, a sign-in).
- Policy: "whenever event X, decide and issue command Y". There is a command
  after every gate, not only at the end of a flow.
- Decider: a pluggable interface, not an enum. It takes the packet and the
  policy state and returns a decision with a confidence. Implementations:
  code, an agent, Nil (with an agent's prediction shown as the Premove), and
  composites (the agent decides above a threshold Nil sets, else Nil). Every
  policy starts with Nil as its decider. Only Nil switches a decider, as his
  own event in the app; an edit to a file never does, because agents edit
  files.
- Decision kind: the policy that asked. It keys precedent, calibration and
  which event the answer emits.

## Cards

- Two card types: decision cards and action cards.
- The decision packet is everything. The agent that makes it shapes it for
  ease of decision (smart diff, screenshots, video, demo, forecast, chart,
  alternatives with "closer to this one" refinement). Other fields are
  metadata: logged for audit, shown only when they help.
- Each decision card has a prediction with a confidence and an adversarial
  note. An action card has nothing to predict.
- Each card has a consult agent that Nil can chat with right there: the
  predictor (independent of the author, with its own criteria). It asks the
  author for facts the author alone has. This is the one field outside the
  packet.
- No rooms in the core. The source is metadata. Filters and sorts do the rest,
  as in the current loop app (priority floor, worker count, sort by date or
  priority, filter by source).

## Precedent (Nil: Antecedent)

One append-only decision log in the app's data directory. Each line: the
policy, a snapshot of the card, the prediction and its confidence, Nil's
call, the outcome (matched, matched with edits, changed), his note, the time.
Each predictor reads only its own policy's lines, as examples (no training).
Calibration is shown per policy ("at 90% or more, matched 47 of 50"), counting
clean matches only. Edits go to the predictor as precedent, so it learns to
make them.

## Flows

- No workflow object. Policies chain by events (choreography).
- A workflow is a just-in-time view, derived from two sources: the policy
  configuration (what can happen; shows dead ends and orphans) and the history
  (what did happen).
- A check: every emitted event has a subscriber or is marked final, and every
  subscribed event has an emitter.
- Stateful policies (the push point, dispatch, release) are reducers over the
  event log: state plus one event gives the new state plus the events and
  commands to emit. Commands are logged as events too, so replaying the log
  rebuilds state and sends nothing.
- Orchestration is not a primitive. A flow that needs one owner (the release:
  push, wait for CI, tag, check the Hosted deploy) is one stateful policy.
- Time is an event (clock ticks).

## What is generic and what is per project

- Generic: the app, the agent contract with it (post a packet, receive a
  command, report its result as an event), deciders.
- Per project: a policies file in the project's repo (events, policies,
  deciders, actors, named agents as metadata), and the project's own skills
  (for isomux: claim, design, edit token, hand-off, merge).
- Nothing about the SDLC is hardcoded. The isomux flow is the first set of
  policies. Writing down push and release rules (today tribal knowledge) is
  part of the work.

## Not adopted

Anything from Gas City. Aging or re-nudging cards. Grouping or interleaving
rules (a filter does it). A general workflow engine.

## Migration

A new app on its own port with its own data directory, beside the running
isomux-loop app (~/nil/isomux-loop), which stays live. It reads the same
isomux board. Decision kinds move one at a time: triage first. The current
app keeps sign-off and push until each moves. Push to the public repo stays
Nil's decision.
