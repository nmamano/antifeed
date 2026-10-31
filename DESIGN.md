# Antifeed design

Draft 2, 2026-10-25, Antifeed Builder, after Antifeed Reviewer's review of
draft 1 (4aadcc2) and Chief Researcher's pointers. THESIS.md wins over this file. Each
choice that THESIS.md does not make is marked **(choice)**. Disagreements with
THESIS.md are in the last section; THESIS.md is not changed.

Sources read on 2026-10-25: THESIS.md, ESSAY.md, ~/nil/loop-app
(DELIVERABLE.md, design/architecture.md, prototypes 1-4 with their READMEs,
types and audits), and the live loop app (~/nil/isomux-loop: README, store.ts,
packets.ts, loop.ts, config.ts, the sign-off outline, GET /api/help) and the
isomux-curator skill. Prototype facts come from two read-only subagent
reports; the file and line references are theirs.

## 1. Shape

- One Bun + TypeScript process, no framework, a plain JS page (as isomux-loop
  and the prototypes). **(choice)**
- Registered as an isomux app named `antifeed` when its page first needs Nil's
  look (slice 4). The registry assigns the port (21040 was the next free one
  on 2026-10-25) and `$ISOMUX_APP_DATA_DIR`. Port 21025 and its data stay with
  the loop app.
- Data directory: `events.jsonl`, `decisions.jsonl`, `blobs/`. Every view is a
  projection of `events.jsonl`.
- Agent routes (section 7) take requests on 127.0.0.1 with no auth, as the
  loop app does today. No agent route writes an event with `by: human:*`.
  **(choice)**
- Human routes (decide, undo, refine, rewrite, decider switch, action card
  done or failed, consult messages) require `X-Isomux-Member-Id` equal to
  Nil's member id (a constant), and the event logs it. A request through the
  app's office URL carries that header, and the office removes `X-Isomux-*`
  headers that a browser sends (isomux apps reference, read 2026-10-25). A
  direct request to the port can set the header, so this check stops
  mistakes, not a process on the box that forges the header on purpose.
- The app reaches agents and the board with its app token.

## 2. Core types

```ts
// Who does a thing. "nil" is the human; one per office for now.
type ActorRef = `agent:${string}` | `code:${string}` | `human:${string}` | `clock`;

type Actor =
  | { id: string; kind: "agent"; agentName: string; skill?: string } // name resolved to an id at send time
  | { id: string; kind: "code"; handler: string }                    // a function in the app or the policies module
  | { id: string; kind: "human"; member: string };                   // "Nil"

// A past fact. Append-only. `at` is the only clock a reducer may read.
type Event = {
  seq: number;            // 1, 2, 3 ... in file order
  id: string;             // "e_" + ULID
  at: string;             // ISO time, UTC
  type: string;           // "board.task.filed", "card.decided", "command.done", "clock.tick" ...
  by: ActorRef;
  project?: string;       // "isomux"
  subject?: string;       // "isomux:task:3f2a9c1b"; the thing it is about
  card?: string;          // card id, when it is about a card
  command?: string;       // command id, when it is about a command
  causedBy?: string;      // event id
  key?: string;           // idempotency key from the reporter; a repeat is dropped
  batch: string;          // "b_" + ULID; one write, ended by a batch.end line (section 4)
  member?: string;        // X-Isomux-Member-Id, on events from human routes
  data: unknown;
};

// Imperative, one actor, can fail. Lives only as events:
// command.issued -> command.delivered -> command.started -> command.done | command.failed
// (command.cancelled before delivery). Section 4 has the delivery rules.
type Command = {
  id: string;             // "k_" + ULID
  type: string;           // "triage.prepare", "triage.apply"
  policy: string;
  actor: string;          // Actor.id from the policies file
  subject?: string;
  params: unknown;
  causedBy: string;       // the event that made the policy issue it
};

// A stateful policy is a pure reducer. The engine turns every `out` item into
// a logged event (section 4), in the same write as the event that caused it.
// Replay reads those logged events and never acts on `out`.
type Reaction<S> = {
  state: S;
  out?: Array<
    | { emit: { type: string; subject?: string; data: unknown } }   // only a type in `emits`
    | { issue: Omit<Command, "id" | "policy" | "causedBy"> }      // -> command.issued
    | { open: CardDraft }            // -> card.opened; waits for its packet or decider
    | { withdraw: string }           // -> card.withdrawn
    | { cancel: string }             // -> command.cancelled, own command, before delivery only
    | { wakeAt: string }             // -> clock.wake.requested {policy, at}
    | { reissue: { command: string; actor?: string } }  // built-in command-failed only
  >;
};
// CardDraft (slice 2): {subject?, meta?, prepare?: {type, params}, packet?}.
// prepare issues the author's command in the same batch, linked to the new
// card (Command.card); packet makes the policy itself the author.

type Policy<S = unknown> = {
  id: string;                        // the decision kind: keys precedent, calibration, answer event
  project: string;
  on: string[];                      // event types it subscribes to
  emits: string[];                   // event types it may emit
  final?: string[];                  // emitted events that need no subscriber
  commands: Record<string, {
    actor: string;
    delivery: "at-least-once" | "at-most-once";   // section 4; at-most-once for anything irreversible
    burstMs?: number; timeoutMs?: number;
  }>;
  decider?: DeciderConfig;           // absent: a reaction with no choice in it (see 2.1)
  answer?: AnswerSchema;             // fields of a call, for decision cards
  primary?: string[];                // answer fields whose change makes the outcome "changed"
  author?: string;                   // the actor that shapes packets for this kind
  validate?: (call: Call) => string | null;   // checks beyond the schema (go needs a priority)
  init: S;
  reduce(state: S, e: Event): Reaction<S>;
};
```

### 2.1 Deciders

```ts
type Call = Record<string, string | null> & { note?: string };
type Prediction = {
  call: Call;
  confidence: number;     // 0..1
  why: string;
  against: string;        // the adversarial note: the best case against this call
  by: ActorRef;           // "agent:triage-predictor@sonnet#<criteria hash>": a new criteria file is a new predictor
  precedent: string[];    // decision-log ids it read
};

type DeciderStep =
  | { kind: "decided"; prediction: Prediction }       // decides with prediction.call, after the Premove check
  | { kind: "ask"; prediction: Prediction | null };   // the card goes to Nil's queue

interface Decider {
  id: string;
  // Called once per card version, when its packet is in. Async: an agent
  // decider takes seconds. Its result is logged as an event (card.predicted,
  // card.decided), so replay never calls a decider again.
  decide(card: Card, policyState: unknown, precedent: DecisionLine[]): Promise<DeciderStep>;
}

type DeciderConfig =
  | { kind: "code"; handler: string }
  | { kind: "agent"; model: string; criteria: string }         // criteria: a prompt file in the project repo
  | { kind: "nil"; predictor?: DeciderConfig }                       // any decider can predict
  | { kind: "threshold"; agent: DeciderConfig; min: number };        // it decides at >= min, else Nil
```

- Every policy with a decider runs as `nil` until an event from Nil sets
  another decider (`policy.decider.set` by `human:Nil`, from the policy's
  calibration page, through a human route). This holds for `code`, `agent`
  and `threshold`, also when the file names one of them: the file value is
  what the switch offers, not what runs. The file also sets `autoAllowed`
  (default false); a policy with `autoAllowed: false` (push, release,
  anything irreversible) never leaves `nil`. **(choice)**
- A policy with no decider is a reaction. It issues only commands that the
  trigger event fully sets: forward, withdraw, deliver. A decider-less
  reducer that branches on packet content would be a hidden automatic
  decision, so the reviewer checks each decider-less reducer against this
  rule. **(choice)**
- The engine checks every `out` item: a policy emits only the types in its
  `emits` and never a generic type (`card.*`, `command.*`, `policy.*`,
  `clock.*`, `consult.*`), issues only the command types in its `commands`
  (to the actor declared there), and opens or withdraws only its own cards.
  A violation is logged as `policy.refused` and the item is dropped. Without
  this, an edit to a policies file could switch a decider or send a command
  to an actor that no declaration names.
- A card in `predicting` at a restart gets a new predictor run (live work).
  A predictor that fails or passes its timeout leaves the card with no
  prediction, and the card goes to the queue (outcome `unpredicted`). A
  prediction that arrives after the card's `shownAt` is not the Premove for
  that decision and is not counted in calibration. **(choice)**
- The predictor is a headless `claude -p --strict-mcp-config --setting-sources
  project --no-session-persistence --tools ""` run with a JSON schema, one per card version, cached by
  prompt hash, with a daily cap (Proto 1 `ClaudeRunner`/`CachedRunner`,
  Proto 3 `callJson`). It gets no tools: the packet must carry the evidence.
  It reads the packet as Nil sees it, without the author's recommended mark
  (Proto 1 rule; Proto 3's predictor saw the author's proposal and leaned on
  it: 127 of 240 exact, the same count as the Curator's own proposals,
  measured 2026-10-21).
  Packet text is data, not orders (Proto 4 `predictorPrompt`). Model per
  policy; sonnet for triage, cost not measured yet. **(choice)**

## 3. Cards and packets

```ts
type Card = {
  id: string;                         // "c_" + ULID
  kind: "decision" | "action";
  policy: string; project: string; subject?: string;
  version: number;                    // +1 at each new packet (rewrite, refine)
  state: "preparing" | "predicting" | "open" | "decided" | "done" | "withdrawn";  // done: action cards
  packet: Packet | null;              // null while the author prepares it
  prediction: Prediction | null;      // decision cards only
  consult: { sessionId?: string };    // the predictor's chat on this card
  meta: {                             // logged, shown only when it helps; filters and sorts read it
    source: string;                   // "isomux board", "Isomux Worker 2"
    author: ActorRef; openedAt: string;
    raw: string;                      // required: a link to the source as it came (the board task, the email)
    priority?: string; effort?: string; createdBy?: string;
  };
  command?: string;                   // action cards: the command Nil carries out
};

type Packet = {
  question: string;                   // the heading
  blocks: Block[];                    // the author shapes the order
  options?: Option[];                 // 2-4 presets; each fills the call
  recommended?: string;               // the author's pick; shown to Nil, hidden from the predictor
};

type Block =
  | { type: "markdown"; text: string }
  | { type: "diff"; unified: string; path?: string }
  | { type: "image"; blob: string; caption?: string; pair?: { name: string; side: "before" | "after" }; focus?: { x: number; y: number; w: number; h: number } } // focus: what needs Nil's attention, fractions of the image; the page boxes it in red (7)
  | { type: "video"; blob: string; caption?: string }
  | { type: "link"; url: string; label: string }
  | { type: "demo"; url: string }                     // opens in place
  | { type: "chart"; spec: unknown }                  // Vega-Lite
  | { type: "draft"; key: string; text: string }      // text Nil may edit; the edit goes in the call
  | { type: "checklist"; items: string[] }            // action cards
  | { type: "fields"; rows: [string, string][] }
  | { type: "fold"; title: string; blocks: Block[] }; // evidence, folded

type Option = { id: string; label: string; cost?: string; fill: Call; blocks?: Block[] };
type AnswerSchema = Record<string, { enum?: (string | null)[]; text?: { max: number }; requiredIf?: Record<string, string[]> }>;
```

- Two generic calls on every decision card **(choice)**:
  - `rewrite` with a note: the author makes a new packet as the note asks;
    the card comes back as version +1. This is the loop app's rewrite.
  - `refine` with an option id: "closer to this one". The author returns a
    new packet with variants of that option.
- When Nil decides a card (not a generic call) or the card is withdrawn, the
  engine cancels the policy's prepare commands for that card that are not
  delivered yet. A prepare already delivered gets a 409 on its packet; the
  author reports it done with `{"skipped": ...}`.
- An action card is a command whose actor is `human:Nil`. Its packet holds the
  steps (checklist, links, copy buttons). Nil answers done or failed, with a
  note; that is `command.done` or `command.failed`. An action card never asks
  for a secret value; a secret goes through an isomux secret request.
- Every card shows its `meta.raw` link, so Nil can check the source when the
  packet's summary looks wrong. Proto 4's predictor prefilled "reply" to an
  attacker's address (2026-10-22); the human gate and the raw source are the
  guard. The predictor treats the raw source as data, not orders, as it
  treats the packet. **(choice)**
- Blobs (images, video) go in `blobs/<sha256>.<ext>`. Packets and snapshots
  hold the name, not the bytes. The blob route answers HTTP Range requests
  (206): Chrome on Nil's iPhone is WebKit, which needs them to play video
  (Chief Researcher, 2026-10-25).

## 4. The event log

`events.jsonl`, one Event per line, written only by the app process. Sample:

```json
{"seq":1042,"id":"e_01JB8Z...","at":"2026-10-25T17:02:03.123Z","type":"card.decided","by":"human:Nil","project":"isomux","subject":"isomux:task:3f2a9c1b","card":"c_01JB8X...","causedBy":"e_01JB8Y...","batch":"b_01JB8Z...","member":"<Nil's member id>","data":{"version":1,"call":{"choice":"go","priority":"P1","note":""},"shownAt":"2026-10-25T17:01:55.900Z"}}
```

- One batch per input **(choice)**. For an incoming event, the engine first
  computes the whole reaction: the fixpoint over all policies, because an
  emitted event feeds other policies. Then it appends the event and every
  derived event (`command.issued`, `card.opened`, `card.withdrawn`,
  `clock.wake.requested`, emitted events) in one write with one fsync, and
  only then answers the HTTP request with 2xx or sends anything. Each line
  carries the batch id; the batch ends with a `batch.end` line.
- Load: read every line, fold every policy and the projections from the
  logged events. A batch with no `batch.end` (a crash during the write) is
  moved whole to `events.torn-<time>` and dropped; its request got no 2xx.
  Load never makes missing derived events from `out`: changed reducer code
  would invent commands (see code changes below).
- Replay sends nothing. The dispatcher and the clock are live work after the
  replay:
  - The clock rebuilds its pending wakes from `clock.wake.requested` with no
    `clock.tick` after it. A wake that fell in the downtime fires late, with
    the real time in `at`. Time is an event, but sparse: no tick is logged
    that no reducer asked for. **(choice)**
  - The dispatcher sends `command.issued` with no `command.delivered`, under
    the delivery rule of its command type:
    - `at-least-once`: the dispatcher sends, then logs `command.delivered`. A
      crash between the two sends it again. The actor calls `POST
      /api/commands/:id/start` before it acts (`command.started`); a second
      start gets 409, so two deliveries cannot both run.
    - `at-most-once` (push, merge, release, anything irreversible): the
      dispatcher logs `command.delivered` before the send and never sends
      again. A lost message reaches `timeoutMs` and becomes a
      `command-failed` card for Nil.
    - Both: the actor starts every command before it acts, and start
      refuses a cancelled, finished or started command (section 7).
  - At start, the dispatcher sends only commands issued less than `burstMs`
    + 10 minutes ago. An older one becomes a `command-failed` card for Nil:
    "stale after restart: send or drop". This stops a restored backup or a
    copied data dir from sending old commands. Tests and fixtures use a
    transport that cannot send. **(choice)**
- Code changes: each load appends `policies.loaded` {project, file hash}.
  After a load with a new hash, the engine recomputes `out` over the old
  events and compares it with the logged derived events. The flow view
  shows the differences; the engine never sends them. **(choice)**
- No hash chain **(choice)**: one writer on Nil's box; the Proto 2 audit
  showed a chain alone does not stop a full re-seal (2026-10-22).
- Generic event types (only the engine emits them): `card.opened`,
  `card.packet`, `card.predicted`, `card.decided`, `card.undone`,
  `card.withdrawn`, `command.issued`, `command.delivered`, `command.started`,
  `command.done`, `command.failed`, `command.cancelled`, `consult.asked`,
  `consult.answered`, `policy.decider.set`, `policy.refused`,
  `policies.loaded`, `clock.wake.requested`, `clock.tick`, `batch.end`.

## 5. The decision log

`decisions.jsonl`, one line per decided card version, written after the
batch that holds its `card.decided` event. `events.jsonl` is the truth: on
load the app checks `decisions.jsonl` against it and rebuilds it when a line
is missing or doubled. It is kept apart so predictors and calibration read
one small file. Sample:

```json
{"id":"d_01JB8Z...","at":"2026-10-25T17:02:03.123Z","policy":"triage","project":"isomux","card":"c_01JB8X...","version":1,"subject":"isomux:task:3f2a9c1b","snapshot":{"question":"...","blocks":[{"type":"markdown","text":"..."}],"options":[],"recommended":null,"meta":{"source":"isomux board","raw":"<board task link>","priority":"P2"}},"prediction":{"call":{"choice":"go","priority":"P2"},"confidence":0.82,"why":"...","against":"...","by":"agent:triage-predictor@sonnet#9c41e0","precedent":["d_01JB7...","d_01JB6..."]},"call":{"choice":"go","priority":"P1","note":""},"by":"human:Nil","outcome":"edited","note":"","secondsToDecide":7.2}
```

- Outcome **(choice)**: `matched` (every answer field equal, empty note),
  `edited` (the `primary` fields equal, another field or a note differs),
  `changed` (a `primary` field differs; `rewrite` and `refine` count here),
  `unpredicted` (no prediction; out of calibration, and in eDPM: section 15). For
  triage `primary` is `choice`, so a priority bump is `edited`.
- The line keeps the full prediction (`why`, `precedent` ids) and the full
  snapshot, `recommended` included, for audit.
- Undo appends `{"id":"d_...","at":"...","undoes":"d_..."}`. Readers skip an
  undone line. Nil's Undo of a card an agent decided puts it back in his
  queue with the agent's call as its prediction; his next call is a line by
  Nil, counted against the agent's call.
- Precedent: a predictor reads only its own policy's lines, newest first,
  within a prompt budget; past the budget it picks by word overlap (Proto 3
  `similarPast`), decided-before only. Agent-decided lines are not precedent
  (Proto 2: learning from them is circular). The precedent reader removes
  `recommended` from each snapshot and the Curator's proposal from imported
  lines; if not, the predictor learns "copy the author" through precedent.
- Calibration per policy and per predictor version (`Prediction.by` holds the
  criteria hash), so Nil does not switch on numbers from an older predictor:
  confidence bands >= 0.9, 0.7-0.9, 0.5-0.7, < 0.5, each "matched k of n"
  (clean matches only) with a Wilson lower bound (Proto 3 `wilsonLower`).
- After a switch to `threshold`, cards at or above `min` stop reaching Nil,
  so the calibration of those bands stops at the switch time. The page says
  so. After the switch, Nil's Undo of an agent-decided card is the only
  signal for those bands.
- DPM and eDPM, weekly, per policy and in total: Nil's decisions (and the
  effective ones, section 15) per active minute. An active minute is the union
  of the spans from `shownAt` to the decision, each capped at 5 minutes.
  **(choice)**
- Seed: triage starts with the loop app's applied triage decisions, read
  through its API (`GET /api/items?state=applied`), marked `"imported":true`.
  They are precedent only: not in calibration or DPM (another predictor made
  those calls). The seed never copies Proto 3's `data/private`, which is
  Nil's private snapshot. **(choice)**

## 6. The policies file

Per project, a TypeScript module that the app imports: declarations are data
(the flow check and the flow view read them), reducers are code. One file,
because a stateful policy is code and two files would drift. **(choice)**

```ts
// <project repo>/antifeed/policies.ts
import { definePolicies } from "antifeed";
import { triage } from "./triage";          // reducer and helpers in the same folder

export default definePolicies({
  project: "isomux",
  actors: [
    { id: "curator", kind: "agent", agentName: "Isomux Curator", skill: "isomux-curator" },
    { id: "nil", kind: "human", member: "Nil" },
  ],
  sources: [{ id: "board", kind: "isomux-board", roomId: "e6818e47", everyMs: 60_000 }],
  events: {                                  // project events and their emitters
    "board.task.seen": { from: "board" }, "board.task.filed": { from: "board" },
    "board.task.changed": { from: "board" }, "board.task.closed": { from: "board" },
    "triage.decided": { from: "triage" },
  },
  policies: [triage],
  agents: { "Isomux Curator": "author and actor of triage" },   // metadata only
});
```

- Load check, run at start and shown on the flow view: every emitted event
  has a subscriber or is `final`; every subscribed event has an emitter; every
  command names a declared actor; every decider config parses. A project that
  fails the check does not load; the other projects run. **(choice)**
- The app keeps a constant list of policies file paths. **(choice)**

## 7. The agent contract

Three moves, all on `http://127.0.0.1:<port>`:

1. **Receive a command.** The app sends the actor one office message per
   burst: `/<actor's skill> Antifeed: <n> commands` (no slash when the actor
   declares no skill: the office runs a message that starts with "/" as a
   skill) and one line per command (`<id> <type> <subject>`). `burstMs` per command type sets the wait for more (triage.apply:
   3 minutes, as `TRIAGE_QUIET_MS`, so an Undo inside it cancels the command
   before delivery). `GET /api/commands/:id` gives the full command and its
   state. Before it acts on any command, the actor calls `POST
   /api/commands/:id/start`; a 409 means the command was cancelled (an Undo
   during the send), finished, or started by another delivery: it does not
   act. The dispatcher sends only commands still issued after its last wait,
   and an `at-most-once` one only when its own call logged the delivery.
2. **Post a packet.** `POST /api/cards` with `{command?, policy, subject,
   packet, meta}`. With `command`, the packet answers that prepare command and
   reports it done. Without one, the policy must list the poster as an author
   (for example a worker's design packet, later). Images: `POST
   /api/blobs` (raw bytes), then name the blob in a block. A screenshot
   marks the part that needs Nil's attention with a red box, and both halves
   of a before/after pair box the same region (Nil, 2026-10-25, relayed by
   Isomux PM). The author gives that region as the image's `focus` (round 9):
   the card shows the image cropped around it, with the red box, so Nil sees
   the defect without a tap; the viewer shows the whole image with the box.
3. **Report a result as an event.** `POST /api/commands/:id/result` with
   `{ok, data?, error?}` gives `command.done` or `command.failed`. Facts that
   are not command results: `POST /api/events` with `{type, subject, data,
   key}`, only for an event type the policies file lets that actor emit.

Slice 3 (as built): `GET /api/help` lists the routes. `POST /api/events`
takes actors only; a source (the board poller) is inside the app and writes
through the engine, never through HTTP. A code actor's command runs
`run[handler](command)` from the policies file. The app holds a lock file
(`antifeed.lock`, the pid) on its data dir, so a second process on the same
log refuses to start. A process with no office token sends and reads
nothing.

Slice 4 (as built): the page is served at `/` by the same process (src/page.ts,
client.js, page.css; the loop app's look and keys). Tabs: Queue (decision and
action cards in one list, with sort, filters and search), Decided (with Undo),
Numbers (weekly DPM and eDPM next to the match rate; calibration per
predictor), Flow (each policy's events, commands and actors, with counts from
the log) and Status. Two read routes serve it: `GET /api/policies` and `GET
/api/flow`. `DEMO` in src/config.ts loads only projects/demo, in the data
dir's `demo/` folder (`DEMO_DIR` in src/config.ts since 2026-10-25: a new name is a fresh seed); slice 6 turns it off, and the live log starts in
`live/`.

Slice 5 (as built): src/predictor.ts is the `agent` decider. Its prompt has
the criteria file, its own policy's precedent (the 10 newest lines, then the
most similar by word overlap, within 30,000 characters) and the card as Nil
sees it (options without the author's pick). Its schema comes from the
policy's answer fields. Its `by` is `agent:predictor@<model>#<hash of the
prompt version and the criteria>`. src/claude.ts runs `claude -p` in its own
process group in an empty folder and kills the group when the engine's
timeout aborts it. Caps: $0.50 a run, 300 predictor runs a Pacific day. The
consult (src/consult.ts) is `POST /api/cards/:id/consult`, a human route. Its
answer is a `consult.answered` event. A last line `ASK AUTHOR: <question>`
makes the engine issue `consult.ask` to the policy's author; the author's
result `{answer}` comes back as a `consult.author` turn, and the consult
answers again in the same session. The loop app's applied triage calls
become a `precedent.imported` event (src/seed-loop.ts); slice 6 runs it once.
A live run on 2026-10-25 (sonnet, the demo triage card): a prediction in
10.8 s for $0.023, consult turns for $0.006 and $0.009.

Slice 6 (as built, not live): projects/isomux holds the triage policy, its
predictor criteria, the draft Curator skill and SWITCH.md (the steps, the
dry run and the rollback). The Curator's proposed title and scope are draft
blocks in the packet, so the predictor predicts only the choice and the
priority. `DEMO = false` in src/config.ts is the switch.

Rules: an agent acts on a command id at most once (the start call above; a
repeat result is dropped by id). `command-failed` is a generic policy of the
app, with decider `nil` and switchable like any other. It subscribes to
`command.failed`, to commands past their `timeoutMs`, and to stale commands
at start (section 4), and opens a card: retry, reassign or drop. **(choice)**

Consult: the card's chat is a `claude -p` session of its own, started with
the packet as Nil saw it, the prediction and its precedent ids, so it works
also for a cached prediction. It is kept with `--resume` for the
next message (the prediction run itself keeps no session). The chat is a
human route (section 1). When the consult needs a fact only the author has, its reply
names the question; the app issues `consult.ask` to the author, and the
author's result goes back into the session. Each turn is logged as
`consult.asked` / `consult.answered`. **(choice)**

## 8. Triage moves from the loop app

Today the Curator is the author and the predictor in one (its proposal is the
prefill) and the actor that writes the board. The loop app wakes it every 10
minutes with untagged P0-P3 tasks, shows its proposals on Triage, and sends
Nil's decisions in one message per burst.

In Antifeed, policy `triage` (stateful, decider `nil` with the triage
predictor) does this:

1. The board source reads the board every 60 s and emits `board.task.*`.
   Its state is the projection of the logged `board.*` events, so it diffs
   against the log and a restart emits nothing new. Only the first read ever
   emits `board.task.seen` for every open task.
2. For an open P0-P3 task with no `[class | state]` tag and no card, `triage`
   opens a card and issues `triage.prepare` to the Curator.
3. The Curator posts the packet: the task in plain words, what it checked
   (git log, related tasks), effort with its reason, a proposed title and
   scope when needed, its own recommendation as `recommended`, and the board
   task as `meta.raw`. It argues
   against the task first, as its skill says today.
4. The predictor predicts (choice, priority, confidence, adversarial note).
   The card goes to Nil's queue with the prediction as the Premove.
5. Nil calls: go, design, hold (with P0-P3), backlog, obsolete, rewrite or
   refine, and a note. `triage` emits `triage.decided` and issues
   `triage.apply` to the Curator, burst-delivered.
6. The Curator writes the board as its skill says today and reports the
   result. A closed task withdraws its open card (step 1 sees it close). A
   `board.task.changed` on a task with an open card marks the card "task
   changed after packet" and issues `triage.prepare` again (version +1).
7. Undo before delivery cancels the command. Undo after delivery reopens the
   card; Nil's next call issues a new `triage.apply` that writes over it, as
   the loop app does.

What the Curator does differently: it stops proposing in the loop app; it
answers commands instead of the wake; its recommendation is packet content,
not the prefill; it reports each write by command id instead of
`decidedAt`; it answers consult questions.

What the loop app stops doing: the "open tasks" part of the curator wake and
the Triage cards for those tasks. It keeps the Backlog and On hold tabs (and
"Bring in", "Back to Triage"), design packets, Sign-off, Push, dispatch and
the tick until each kind moves. The loop app's code stays as it is unless Nil
rules otherwise (open question 1). Before the switch, Nil decides or the
Curator withdraws the open Triage cards in the loop app, so no task has a
card in both.

The isomux-curator skill change is written by me as a draft and applied at
the switch by its owner (Isomux PM decides who).

## 9. Reuse

| From | Part | Why |
|---|---|---|
| Proto 1 | JSONL trail append and load (`src/trail.ts`), `project()` | The event log shape, minus the hash |
| Proto 1 | `ClaudeRunner`, `CachedRunner` (`src/runner.ts`) | Predictor runs: fixture replay for tests, daily cap, strict MCP |
| Proto 1 | `decide()` bookkeeping (`engine.ts:328-360`); predictor never sees the recommended mark | Decision log fields, predictor independence |
| Proto 2 | Reducer `apply`/`project` and its replay-equality test (`model.ts`, `core.test.ts:230`) | Stateful policies; replay proof |
| Proto 2 | `Sequencer.handle`: idempotent ids, `expectedVersion`, refusals logged | Command and card-version checks |
| Proto 3 | `wilsonLower`, `similarPast`, predictor prompt and schema, `callJson` cost ledger, `regression()` | Calibration, precedent pick, rescoring when criteria change |
| Proto 4 | `predictorPrompt` ("predict the person"), `Block` union, `ActionPacket`, `requestEffect`, undo hold | Predictor prompt, packet blocks, action cards, no effect without a decision |
| isomux-loop | Keyboard map, Undo, filters and sorts, image viewer, burst delivery, `parseTag`, `offBoard`, validation helpers | Nil already uses them; copied, not imported |

Not reused: the hash chain and SQLite (one writer, low volume, JSONL is enough
and greppable), Proto 3's rule miner (its rules lost to plain examples: 125
vs 127 exact of 240, 2026-10-21), batch prediction, the trust-ladder rungs
(replaced by deciders and Nil's threshold), multiplayer roles, input
`PrepLevel`.

Risk carried over: Proto 3's predictor got 6 of the 113 triage cards that Nil
changed, and at confidence >= 0.9 it matched 53 of 83 (2026-10-21, replay of
his real decisions). Expect triage to stay on decider `nil` for a while; the
gain at first is packet shape and one queue, not auto-decisions.

## 10. Slices after slice 1

| Slice | Content | Review |
|---|---|---|
| 2 | Engine, no network: event log, decision log, reducer runner, replay, policies loader and check, Decider interface with `code`, `nil`, `threshold`, outcome compare, calibration and DPM math. Tests: replay equality, flow check, outcomes, a fake triage policy. | Reviewer |
| 3 | I/O: HTTP API of section 7, the human routes and their member check (section 1), dispatcher with delivery rules and burst delivery through office messages, board source (read-only), blobs with Range. Tests against a fake office and a transport that cannot send. | Reviewer (it messages agents; it guards `human:Nil`) |
| 4 | Page: queue, card blocks, keyboard, Undo, filters and sorts, action cards, failed-command cards, status, flow view (config graph, history counts, replay differences). App registered on its own port, run on a fixture project. It calls only the slice 3 routes. | None: Nil's look |
| 5 | Predictor and consult: `agent` decider, precedent pick, adversarial note, consult with author relay, calibration and weekly DPM pages, precedent seed from the loop app API. | Reviewer (a decider) |
| 6 | isomux triage policies file, Curator skill draft, switch: the Curator moves, the loop app stops its triage part. Needs Nil's go and his answer to open question 1. | Reviewer (writes the board through the Curator) |
| Later | Override reason (Chief Researcher's pointer, from the Research Lab ideas): when Nil changes a call, the card shows an optional field "was the reason in the packet or outside it?" and offers to add the outside source as an input. It is never a step that Nil must answer before the call goes through. | Reviewer (it adds a source) |
| Later | One slice per kind, each with Nil's go to move it: design packets, backlog and hold, sign-off, push point (stateful, `autoAllowed: false`), dispatch, release. Writing down the push and release rules is part of their slices. | Reviewer, each |

## 11. Questions for Nil

Nil answered both on 2026-10-25: "Approve as recommended (Q1 A, Q2 A)".

1. The loop app must stop announcing untagged P0-P3 tasks to the Curator when
   triage moves, and the room rule keeps the loop app untouched.
   - A. Its owner makes one change at the switch: the "open tasks" part of the
     wake turns off (one constant, easy to revert). **Recommended.**
   - B. No change: the Curator ignores that part of the wake. Cost: one empty
     Curator turn an hour while a task waits for Nil in Antifeed.
2. THESIS.md puts the policies file in the project's repo. For isomux that is
   the public repo, so the file and its rules go public at the next push.
   - A. Keep isomux's file in ~/nil/antifeed/projects/isomux/ until Nil wants
     it public; move it with a push he approves. **Recommended.**
   - B. Commit it to ~/nil/isomux now; it goes out with the next push.

## 12. Where THESIS.md looks wrong to me

- "Each card has a prediction with a confidence and an adversarial note."
  An action card has no call to predict: its actor is Nil and its command is
  set. This design gives action cards no prediction.
- eDPM counts calls Nil changed or edited, so a worse predictor raises it.
  Show it next to each policy's clean-match rate, or a falling predictor
  reads as a gain. Section 15 has the rule since 2026-10-26.
- "Each policy names its decider in its configuration" and "nothing is
  decided automatically until Nil switches a policy's decider": if the
  switch is a file edit, an agent makes it. This design keeps the file as the
  ceiling and makes the switch Nil's event in the app (section 2.1). That
  holds only with the member check on human routes (section 1) and the
  engine's check of each policy's `out` (section 2.1).

## 13. Slice 4b: the page rework (Nil's look, 2026-10-25)

Nil tried the page on 2026-10-25 and found it not ready (11 points, then 3
more, through Isomux PM). Isomux PM's calls on the same day: the switch
stays off; 4b is reviewed by Antifeed Reviewer as a product, with Nil's
list as the floor, not the ceiling. This section wins over sections 2.1, 3
and 7 where they differ.

### 13.1 One persistent agent per project predicts and answers

Nil, 2026-10-25, on the stateless claude -p predictor and consult: "this is
gonna be a terrible experience. i dont want that."

- Each project declares one consult agent as an actor, and names it as the
  project's consult: `actors: [{ id: "consult", kind: "agent", agentName:
  "Isomux Consult", skill: "antifeed-consult" }]`, `consult: "consult"`.
  Isomux PM spawns it, with automatic handoff at 300k tokens (isomux's
  per-agent `autoHandoffTokens`, shared/types.ts). It is never the author of
  a packet: the policies check refuses a project whose consult actor is a
  policy's `author` or the actor of any of its commands except `predict`.
- It does two jobs, with one memory: it predicts each card (the Premove), and
  it answers Nil about any card in the office chat. It remembers what Nil
  told it and its own earlier predictions, until a handoff carries them on
  in its brief.

**Predict as a command (engine change, reviewed).**

- A decider config gains `{ kind: "consult"; criteria: string }`: the
  project's consult agent predicts. For isomux triage:
  `decider: { kind: "nil", predictor: { kind: "consult", criteria:
  "triage-criteria.md" } }`.
- At `card.packet` (decision cards), the engine issues `predict` to the
  consult actor: `{card, version, input}`, at-least-once, no burst. `input`
  is a blob that holds the exact text Antifeed sends: the criteria file, the
  policy's precedent lines (the slice 5 pick, capped at 12,000 characters),
  the packet as Nil sees it (no author's pick), the raw source link and the
  answer fields. The dispatcher sends a new `predict` at once (it ticks
  after an input that issued one, not only every 15 s).
- The agent starts the command, may check facts with read-only steps (the
  project's repo, the board, the card's diff and images through Antifeed's
  blob route), and answers `POST /api/commands/:id/prediction` with `{call,
  confidence, why, against, informed?}`. The engine takes it only for a
  started `predict` command of the card's current version, from the actor it
  was issued to; the answer schema check (checkPrediction) applies. A
  prediction with no command id, for an old version, or for a command that
  is not started is refused (409). The agent routes have no auth, so this
  binding is what keeps a forged prediction from threshold and
  `card.decided`.
- The agent's raw answer (the request body as it came) is stored as a blob
  next to the input; `card.predicted` names both.
- The skill (Antifeed Reviewer, 2026-10-25): the consult actor declares
  skill `antifeed-consult`, so the dispatcher sends `/antifeed-consult
  Antifeed: ...`, and the office runs it as that skill. The skill is
  projects/isomux/antifeed-consult/SKILL.md, created at the spawn. Without
  it the message would be a plain app message, which the agent treats as
  data.
- The life of a `predict` (an engine command, like a generic prepare):
  - `command-failed` does not watch it, so no failure card ever goes to Nil
    for a predict.
  - When the stand-in runs, the engine cancels the predict if it is still
    issued. A started predict stays open for a late answer.
  - On `card.decided`, `card.withdrawn` or a new packet version, the engine
    closes every predict of that card that is still open: cancelled if
    issued, failed with "card moved on" if started. Nothing stays open for
    ever, and a late answer then gets 409.
- `by` = `agent:<agentName>@<model>#<criteria hash>`. The model comes from
  the office's agent list at the time of the prediction ("unknown" if the
  list does not say). A handoff is not a new version.
- `informed`: a prediction is informed when the agent says so (Nil talked
  with it about this card or its task before it predicted) or when the card
  is at version 2 or more and an earlier version was shown to Nil. An
  informed prediction is the Premove but is kept out of calibration and
  counted on its own row.

**Busy, late, and the stand-in.**

- A card waits for the agent's prediction: 120 s for the agent to start the
  `predict` (it is busy otherwise), then 600 s after the start. When either
  wait passes, or the agent fails, the stand-in runs:
  1. A claude -p run (the slice 5 predictor, sonnet) with the same input
     blob. `by: agent:standin@sonnet#<prompt hash>`.
  2. If that fails too: a code vote, `by: code:standin`. The 10 most similar
     precedent lines (3 or more): the most common call, "confidence" its
     share. Else the author's pick, with its option's fill. Else the first
     option's fill, or the first value of each enum field. Each with its
     reason in `why`.
- "No prediction" is not a state of a decision card. The card shows
  "Stand-in" in place of the agent's name, with the reason the agent did
  not answer.
- A stand-in never decides: a threshold decider takes only a prediction from
  the project's consult agent that is not informed and not late, and the
  engine never writes `card.decided` from a stand-in. Stand-ins are kept out
  of the agent's calibration and have their own rows.
- A late agent prediction (after a stand-in) is logged as `card.predicted`
  with `late: true`. If no `card.shown` exists for that version (13.2), it
  becomes the Premove and the prefill. If Nil has seen the card, it is
  shown under the stand-in as "Isomux Consult answered later: <call>", is
  not the prefill, and is not counted in calibration (slice 2's rule: a
  prediction after shownAt is not that decision's Premove).
- The policies check refuses a decision policy with no predictor. The
  built-in `command-failed` has no consult agent: its predictor is the code
  stand-in.

**The chat.**

- The chat is the office's own chat beside an app: the app's
  `messageTargetAgentId` is the consult agent, and Nil opens Antifeed at its
  short URL (https://office.example.com/antifeed). The office shows the
  app with a chat panel for that agent (ui/AppWidgetPage.tsx, read
  2026-10-25: a 420 px floating panel at the bottom right, with images and
  history). Nil is the sender, so the agent treats his words as a member's,
  not as an app's data. Wider than 1280 px, the page keeps a 440 px right
  gutter, so the panel does not cover the card. Alternative, rejected: a
  chat inside the page that relays through the app, because the app would
  send Nil's words as app messages, which an agent treats as data.
- Which card: the page logs `card.shown {version}` once per card version
  when Nil can see its Premove, in the list too, not only as the current
  card (its Premove zone at least half in view) (a human route, `POST
  /api/cards/:id/shown`), and keeps the current card in memory. The agent
  reads `GET /api/consult/context` at each of Nil's messages: the current
  card, with its input blob, the raw answer, the prediction, the stand-in
  reason if any, and the decision so far. `GET /api/cards/:id/context` gives
  the same for a card Nil names. The agent names the card it reads at the
  top of its answer.
- Its limits, in its instructions (projects/isomux/consult-agent.md (not in this public copy), set by
  Isomux PM at the spawn): read only; never decide a card, never call a
  human route (the `X-Isomux-Member-Id` header is Nil's, not its), never
  write the board, never post a packet or a result other than its
  `predict` answers, never edit files; ask the card's author (the Curator)
  through office messaging at most once per message of Nil's. A Claude Code
  agent in isomux has no read-only mode (shared/types.ts: default,
  acceptEdits, bypassPermissions, auto), so these limits are instructions
  only, and the page says so. Isomux PM decides (13.5).
- One consult path: src/consult.ts, `POST /api/cards/:id/consult` (now 410,
  "the consult moved to the office chat"), the engine's `consult.ask`
  relay and the consult part of the spend line are removed. Old `consult.*`
  events stay in the log and replay; nothing makes new ones.
- What the page shows about the agent, and where it comes from: its name and
  live state (the office agent list), its model (same), "hands off at 300k
  tokens" (the office agent list's `autoHandoffTokens`, when the app token
  can read it; else the value set at the spawn, from the policies file),
  what is in its context for this card (the input blob and its earlier
  answers on this card, from the log), and its tools and limits (the text of
  consult-agent.md (not in this public copy)). In the Setup view and in a fold of each Premove zone.
- Cost, not measured: each `predict` puts about 4,000 tokens into the
  agent's context (the 12,000-character precedent cap), so a session holds
  about 60 cards before a handoff.
- Open for later: a second live project has its own consult agent, but the
  office chat beside an app shows one agent. Until then the app's target is
  isomux's consult agent; in DEMO, the demo project's consult actor is the
  same agent and it answers about the demo cards.

### 13.2 The page

- Kinds: each policy declares `name` ("Triage", "Design question",
  "Reply") and may declare `color`; with none, the color comes from a hash
  of the policy id into a fixed palette of 8, so adding a policy moves no
  other color. Action cards show "Action for you".
- Card: four zones a reader tells apart at a glance, each with its own
  heading, border and background:
  1. **Packet**, "From <author>": the question, the source link and the
     author's blocks, on the card's plain background.
  2. **Premove**, "Predicted by Isomux Consult" (or "Stand-in"): the call in
     large type, the confidence, the why, and a fold "How this Premove was
     made" (the input as sent, the raw answer, who made it, the stand-in
     reason). The fold loads its text when opened.
  3. **Against**, "The best case against this call": its own tinted zone.
  4. **Your call**: the fields, the options, the note, Confirm.
  Wider than 900 px: the packet on the left; zones 2 to 4 in a right column
  that stays in view. Narrower: Premove, Against, Packet, Your call.
  (Round 8, L154: one column on every screen: the question, Premove and
  Against, Your call, then the packet.)
- Filters: no native select menus. A row of kind chips (multi-select, in the
  policy's color), one "Priority" control (Any, P0, P0-P1, P0-P2, P0-P3),
  one "Sort" control (Newest, Oldest, Priority), and search. The page never
  replaces a control while Nil uses it. (Round 8, L57 and L58: the loop
  app's set; see 13.13.)
- Text: nothing under 15 px, and every text color at least 7:1 against its
  background, in light and dark.
- Tabs: Queue, Decided, Accuracy (was Numbers: how often the Premove matches
  Nil's call, calibration per predictor, decisions per minute), Flow,
  Setup, Status, Terms.
- Setup (new, read-only): per project, its sources, event types with who may
  emit each, policies (name, color, triggers, emits, commands with actor,
  delivery, burst and timeout, the decider in the file and the one running,
  `autoAllowed`, answer fields, the predictor and its criteria file in a
  fold), actors (kind, agent name, skill, live in the office or not) and the
  consult agent (13.1). Flow links each policy and actor to its Setup entry.
- Terms (Nil, 2026-10-25: "The app needs a page defining the terminology.
  Diagrams if possible."): event, policy, decider, actor, command, action,
  decision card, action card, packet, Premove, Against, stand-in, precedent,
  calibration, DPM and eDPM, kind, consult agent, each in one plain
  sentence. Two diagrams, inline SVG: the cycle event -> policy -> decision
  -> command -> event, and one card's anatomy (the four zones, labelled).
  Each of these words, where the page uses it as a heading or label, links
  to its entry.

### 13.3 Speed

- Measured 2026-10-25, before the change, demo data (45 events), headless
  Chrome on the office box against a local copy (Playwright click to
  content, so the tool's overhead is in each number): first load 388 ms;
  tab switches 63-143 ms (5 rounds of 5 tabs). Each tab switch also waits
  for 1 to 3 sequential requests (Numbers: 3), and one request through the
  office app host took 97-142 ms from the box itself, so Nil waits about
  0.3-0.5 s or more per switch. Server time per route: under 6 ms. Every
  5 s the page rebuilt the whole list, which closed an open select menu
  (Nil's point 2). Script: /tmp/af-speed/measure-before.ts.
- Budget: a tab switch under 100 ms from click to paint, with no request on
  that path; Confirm removes the card in under 100 ms (the request runs
  after); first load in one request after the HTML.
- How: `GET /api/view` gives what the tabs show except Status: the open
  cards, the last 200 decided, policies, flow, setup, accuracy. Its ETag is
  the log's last sequence number plus the office agent list's state (live,
  model), read at most every 30 s. The page keeps the view in memory,
  renders every tab from it, and asks again every 3 s with
  `If-None-Match` (304 when nothing changed). Status (timers, spend) is
  fetched on its own, only while its tab is open. Prompts, raw answers and
  precedent lines load when their fold opens. The HTML carries the first
  view inline. A render replaces only the cards whose content changed, so
  folds, focus, scroll and controls stay.
- After: the same script, plus `performance` marks in the page (click to the
  next animation frame), reported next to the before numbers.

### 13.4 Before the hand-off

- A walkthrough by a fresh agent with no build context (Nil, 2026-10-25:
  "as i said, my list was not exhaustive"): it gets only the URL and "you
  are Nil, triage these cards", and uses every tab with real mouse clicks at
  desktop and phone sizes. Antifeed Reviewer runs it on a scratch copy of
  the app (its own port and data folder under /tmp, the member header set
  in the browser) and holds the bar: every friction fixed, or argued in
  writing. The office chat needs Nil's login, so the chat panel is checked
  only in Isomux PM's walkthrough, which comes after.
- The walkthrough fixture: the scratch copy has no office, so a mode
  (`WALKTHROUGH` in src/config.ts, with DEMO) makes the consult actor a code
  stub that answers at once, labelled "walkthrough stub" in `by`, and seeds
  cards that show each Premove state: the agent's, informed, the claude -p
  stand-in, the code-vote stand-in, and late (shown under a stand-in).
- Then the slice goes to Isomux PM with screenshots of every tab and the
  speed numbers.

### 13.5 For Isomux PM (one packet)

Isomux PM's calls, 2026-10-25: 1 yes, with Opus 5.5 at high effort
("prediction quality is the product"); PM spawns it when this section is
agreed and consult-agent.md (not in this public copy) is committed, and Antifeed Builder sets
`messageTargetAgentId` after the spawn. 2 A: the Setup tab and the chat
panel say plainly that it is read-only by instruction, not by sandbox. 3
yes. The skill `antifeed-consult` is created at the spawn too.


1. The agent: name "Isomux Consult", room Antifeed (05da3a44), Claude Code,
   automatic handoff at 300k tokens, its instructions from
   projects/isomux/consult-agent.md (not in this public copy) (I write it in this slice). The model is
   PM's call.
2. Read-only: a Claude agent has no read-only mode in isomux. A. Instructions
   only, the page says so. **Recommended**: the agent reads the repo, the
   board and Antifeed, and every write path it could misuse needs a forged
   header or a board write that the board's history shows. B. A Codex agent
   with the read-only sandbox: writes are blocked by the engine, but its
   curl to Antifeed and the office may be blocked too (not checked).
3. At the switch: after the owner PATCH (which moves the target with the
   owner), set `messageTargetAgentId` to Isomux Consult (SWITCH.md).

### 13.6 As built (Antifeed Builder, 2026-10-25)

- Engine: `PREDICT` commands and their life (src/engine.ts `predictReaction`,
  `checkPredicts`, `runStandin`, `predictionResult`, `cardShown`); the code
  stand-in in src/standin.ts, also for a run-based predictor that fails; the
  claude -p stand-in and the exact input in src/predictor.ts; text blobs
  (`.txt`) in src/blobs.ts. The clock timer (5 s) runs `checkPredicts`; the
  dispatcher sends a new command at once (`onIssued` -> `kick`, one tick at a
  time). A code consult actor's `by` is `code:<handler>`
  (`code:walkthrough-stub`).
- The page: src/view.ts builds `GET /api/view`; src/client.js draws every tab
  from it and patches only the changed parts; src/page.css. The app's
  `messageTargetAgentId` is Isomux Consult (agent-0000000000003-aaac, set
  2026-10-25).
- The walkthrough copy: `PORT=<spare> ISOMUX_APP_DATA_DIR=/tmp/<dir>
  ANTIFEED_WALKTHROUGH=1 bun run src/main.ts`, with the member header
  `X-Isomux-Member-Id: m0000000` set in the browser. The demo seed plays each
  Premove state: demo-1 and demo-4 the agent's (the stub), demo-2 informed,
  demo-3 the claude -p stand-in (a fake, no spend), demo-5 the code vote,
  demo-7 late before anyone looks (25 s), demo-8 late after the stand-in is
  seen (120 s). The waits are 5 s to start and 15 s to answer. The env var,
  not a constant, so a walkthrough flag can never be committed on.
- Speed after, 2026-10-25, the same copy and method as 13.3
  (/tmp/af-4b/measure-after.ts): the page's own marks, click to the next
  frame, 25 tab switches: median 3.6 ms, max 18.4 ms; Confirm 9.5 ms. With
  Playwright click to content (the before method): 57-195 ms, of which a
  click that changes nothing already takes 50-78 ms. No request on a tab
  switch. First load 335-497 ms (before: 388 ms), one request after the HTML
  fewer.

### 13.7 Review round 2 (Antifeed Reviewer's walkthrough, 2026-10-25)

- A decision line skips a late prediction that Nil did not get as the
  Premove (late and seen), as the card does.
- A note that an option filled in is not an edit.
- Each policy with a decider declares `fallback`: the last stand-in, labelled
  "no basis", in place of the first value of each field.
- Answer fields may declare `label`, `help`, and the rules `needs` and
  `noneWith`; the engine checks them in checkCall, and the page runs the same
  check before a send.
- The page: one column with the packet first and a bottom bar with the call;
  an action's Done waits 10 s for Undo before it is sent; tabs are history
  steps. The item-by-item answers: /tmp/af-4b/answers.md (in the hand-off
  message too).

### 13.8 Review round 3 (the second walkthrough, 2026-10-25)

- An action's Done or Could not do it goes to the engine at once as
  `action.held` (the member, ok, note, and `until`, 10 s later). The engine
  sends it as `command.done` or `command.failed` (by the member, caused by the
  hold) when `until` passes; a 1 s timer runs `finishHeld`. An Undo in that time
  writes `action.released`, and nothing is sent. A restart keeps the hold,
  because it is in the log. One card's Undo touches no other card. After the
  send, Undo is refused: the policy may have acted on the result. `action.` is
  a generic prefix, so no project may declare such an event, and no policy
  hears them as an owner.
- The safe default is never filled in as Nil's call: the card says "No basis:
  pick yourself" and offers "Use the safe default" in one tap. A policy with
  `noDefault` (Wall Game video: Approve posts a video publicly) has no safe
  default: its stand-in runs no model and no vote, fills in nothing, and the
  card gives the policy's words why; only the Predictor's Premove fills in a call.
- Calibration has one row per code stand-in tier (a vote of your past calls,
  the author's pick, a safe default); the weekly rows count the calls that
  matched but for Nil's note ("matched with a note, counts as edited").
- The stand-in reasons in the log use plain words ("the quick model run", "was
  busy: it did not start within 120 s"); the page maps the older wording.
- The page: Confirm and Done wait 700 ms on a new current card; the option the
  Premove names starts picked, with its note; every change from the Premove is
  listed (the option, each field, the note an option wrote). The item-by-item
  answers: /tmp/af-r3/answers.md (in the hand-off message too).

### 13.9 Review round 4 (the third walkthrough, 2026-10-25)

- One rule for every card: a Premove with a basis (the consult agent, a quick
  model run, a vote of past calls, the author's pick) is filled in for Nil to
  confirm, with the option it names and that option's note; a safe default is
  never filled in. Nothing decides a card on its own.
- Confirm waits 700 ms after the current card changes for a key, and 1.5 s on a
  touch screen. The call bar's Confirm is ready only after that and after the
  card's Premove was on the screen (half of it, or half the screen); it fades
  in and says why while it waits.
- On a desktop, the call bar and the toast sit in the header; on a phone, the
  bar is at the bottom and the toast at the top.
- Undo brings back Nil's own call (fields, option, note, draft text) and stays
  on its tab. The page keeps its picks in the tab's session, so a reload keeps
  ticks, notes and edits.
- A safe default counts as no Premove in calibration and in the weekly rows
  (metrics `unfilled`).
- Flow counts commands by final state, and names the ones for a call Nil undid
  ("cancelled by your Undo", "done before your Undo"); action cards are not
  counted as decision cards. Decided says whether Nil confirmed, edited or
  changed the Premove (the view's `outcome`). The item-by-item answers:
  /tmp/af-r4/answers.md (in the hand-off message too).

### 13.10 Review round 5 (the fourth walkthrough, phone and Undo, 2026-10-25)

The bar: what goes out is exactly what the page shows.

- The card part is drawn again only when its data from the server changes.
  Nil's picks (chips, options, texts, the note, ticks) change the call zone in
  place (`syncCall`), so a tap that starts on a button lands on it, and
  "Changed from the Premove" keeps up with every key. It lists the note
  ("Note: added (counts as an edit)").
- "Back to the Premove" resets every field: the Premove's call, the drafts and
  texts as the packet has them, the Premove's option and its note (or none).
- `card.decided` may carry `option`: the packet option the call came from (the
  engine checks that the packet has it, and refuses it with a rewrite or
  refine). The view carries, for a card taken back with Undo, the call that
  went (`undone`: call, option, version), so any device brings it back.
- The code stand-in's tier is data: `standin.basis` (vote, author, none);
  older lines are read from the start of their reason.
- The Confirm guard follows the last pointer: 700 ms after a mouse or a key,
  1.5 s after a touch. It starts when the new card is painted (two frames
  after the change) and again at the page's load. The Premove counts as seen
  only where the toast, the sticky header and the call bar leave it in sight.
- A held action shows in the Queue ("Waiting to be sent", with Undo) and in
  Decided, and its toast comes back after a reload. The toast shows on every
  tab. The item-by-item answers: /tmp/af-r5/answers.md (in the hand-off
  message too).

### 13.11 Review round 6 (the fifth walkthrough, 2026-10-25)

A time guard alone cannot tell a re-tap from a decision, so these are structural:

- The call bar's Confirm needs one act of Nil's on the current card first: a
  scroll he makes (wheel, touch, scroll keys), a tap inside the card (not on
  its Confirm or Done), or Change it. Until then the bar says "Read the card,
  then confirm". The time guard and "Premove seen" stay. A Premove that changes
  under Nil (a late answer) says "updated just now" and must be seen and acted
  on again.
- An action card is never finished by Ctrl+Enter: it takes d or its button.
  With unticked steps the first press warns below the buttons, in place (no
  redraw, no scroll); only the card's own Done, 1 s after the last refused
  press, goes on.
- On a desktop, the toast sits on the left of the header and the call bar on
  the right, so an Undo never shows where Confirm was; an Undo within 700 ms
  of the toast is ignored.
- When the current card moves on elsewhere (another device), the queue says
  so ("Decided on another device: hold") and shows the next card only after
  "Show the next card"; that card gets the guard and the act rule.
- The header call bar is drawn after the queue picks the current card (it
  stayed empty after a load before). The item-by-item answers:
  /tmp/af-r6/answers.md (in the hand-off message too).

### 13.12 Review round 7 (walkthrough 6, 2026-10-25)

- One gate for every path that confirms or finishes (the card's Confirm and
  Done, the bar, Ctrl+Enter, d): the guard, one act on the current card, and,
  for a decision, its Premove seen. Until then the card's Confirm and the bar
  look locked and say why ("Read the card, then confirm."). Acts: a scroll Nil
  makes, a tap or click in the card (not on its Confirm or Done), a pick or a
  key that works on the card, typing in it, Change it, and a mouse that travels
  60 px or more over the card. An input that starts on the call bar, the
  header or the toast is no act.
- No Undo is ignored: the toast and Confirm never share a place (13.11), so
  the 700 ms ignore is gone.
- A held action's or a decision's toast comes back only at page load, not on
  each read of the view, so another device's call never gives this page an
  Undo; the notice of 13.11 covers it, and names Nil's pick here that was not
  sent.
- On a desktop the header keeps one height (48 px brand row), with or without
  the toast and the bar. The item-by-item answers: /tmp/af-r7/answers.md (in
  the hand-off message too).

### 13.13 Review round 8 (2026-10-25)

- A tap or click counts as an act only when it does something on the card: a
  button that is not its Confirm or Done (a pick, a fold), a summary, a link,
  a field, a tick, an image. Plain text and empty space are no act. Scrolls,
  keys on the card and mouse travel stay acts; the travel count starts again
  on each new current card.
- A press at the place of the last call that went out (within 32 px), within
  3 s of it, is a second press of that Confirm: the page stops it before any
  handler, so it is no act, no pick and no focus on the next card.
- touch-action: manipulation on the page: no double-tap zoom, so a tap's
  click is not held back. The item-by-item answers: /tmp/af-r8/answers.md.

Round 8, part 2: Nil's loop app feedback (projects/isomux/LOOP-APP-FEEDBACK.md,
each line with its fix or answer and its check):

- An Undo lasts 24 s: the page's toast (UNDO_MS) and the engine's hold of an
  action's Done (ACTION_UNDO_MS), which were 10 s.
- N1: a press on a Confirm or Done is never dropped by the stray-tap rule;
  readyFor stops a press on a card that is not ready, and says why. A stray
  press can no longer make an act, so this is safe.
- Sorts: Premove priority (the default; backlog is P4, obsolete after it),
  Board priority, Oldest task (the board's createdAt, which the view carries
  as `filedAt`), Newest card, Smallest effort. Filters, many values per row:
  the Premove's call, Board priority (as before), the Premove's priority
  against the board (up, down, same, new), Effort, Filed by (the 10 names
  with the most cards). An action for you passes every filter but Kind and
  search. The Queue tab reads "Queue (3 of 7)" while a filter hides cards.
  The view's local key is af.view3: a sort saved before is not kept.
- The card: the task id with Copy in its head; "Open all folds" (and e)
  closes them when all are open; image blocks with `pair` show side by side
  (stacked on a phone) and open in the viewer as the pair; a swipe moves
  through the viewer, a click on the black closes it.
- The value hold reads "on hold" on the page (chips, call text); the log keeps
  "hold".
- Hover help: every button, chip and label has a title; a Terms word carries
  its Terms sentence. On a phone, the same words are the help lines and the
  Terms links.
- With more than one project loaded, a kind reads "project: name", so the
  Kind filter is a project filter.
- Decided lists withdrawn cards with the reason, from the type and data of
  the event that withdrew the card (the view's `withdrawn`; read only). The
  notice for a current card that left the queue says the same.
- The page is up to 1240 px wide.

### 13.14 Review round 9 (Antifeed PM's walkthrough list, 2026-10-25)

Isomux PM walked the live app at 171fbe7 and sent 12 items; Antifeed PM
owns Antifeed from now on. Checks: tools/round9-checks.ts, and the guard
checks rebuilt in the repo as tools/guard-checks.ts (parts main, x1, touch).

- Nil's call holds its commands for its Undo time: the dispatcher sends a
  command that a `card.decided` caused only CALL_HOLD_MS (= ACTION_UNDO_MS,
  24 s) after it was issued, and a timer sends it then. An Undo in that time
  cancels it (the policy's `cancel`, or the engine's for a generic call), so
  the toast's Undo is true. The demo policy now cancels its demo.apply on
  card.undone, as triage cancels triage.apply.
- An image block may carry `focus` (validated: fractions inside the image).
  The card crops the image around it and draws the red box; an image with
  no focus keeps its shape (up to 560 px tall). The demo pair has a focus.
- The viewer keeps a sideways swipe: touch-action and overscroll-behavior on
  it, preventDefault on a sideways touchmove, and a Back that comes during a
  swipe re-adds the viewer's history step instead of closing it.
- The action card's lines name Done; the step warning says "press".
- The filters fold behind "Filters and sort" on every screen, under one line
  that says what shows and in which order. The call bars hide while they are
  open. On a desktop, the header bar shows only while the whole of Your call
  is off the screen (under the sticky header counts as off); a search
  redraws the page, so the tab count and the bar follow it.
- Hover help is a styled tip at 15 px, 400 ms after the mouse rests; the
  title is held aside while it shows. Copy fixed per the isomux-copy rules;
  a fold's own words are its label.
- The phone toast wraps (up to 3 lines); Board priority says All; Decided
  says what lands there; Flow shows same-shaped policies as one table; each
  Terms arrow stays with its box; Against takes the Premove's height; a
  step's tick is a 44 px target on a phone; placeholders use the muted color.
- The live demo starts again from the seed in `DEMO_DIR` = demo3/.


Round 10 (Antifeed PM's walkthrough of e7ec935, 2026-10-25):
- Nothing moves when Confirm or Done unlocks. The line under the button
  keeps the height of its longest text (two hidden pseudo-elements), and its
  text turns from why it waits to how long the Undo lasts. The locked
  button's 2 px dashed border takes back 1 px of margin, so the button keeps
  its size.
- The call bar shows while the card's Confirm row is off the screen, on a
  desktop too, so one Confirm is always on the screen, and never two.
- On a phone, the viewer shows one half of a pair at a time, at full width;
  Previous, Next and a swipe go from Before to After. The first history step
  names its tab (#queue), so a Back from the viewer keeps it.
- Against is as tall as its text. The crop of a focus image keeps a margin
  of 6% of the box's short side (6 px at least); on a phone a pair uses the
  packet box's full width. The demo focus fits the Log in button and the
  footer in both halves.
- A press hides the tip, and no tip shows again until the mouse moves 8 px.
- A command and a project event may carry `what`: Flow says it in words,
  with the id in its tip; Setup shows both.
- Status says a command of a call waits for the call's Undo time, with the
  seconds left (the dispatcher's heldUntil). The dispatcher reads each
  card.decided from the log once (an index), not at every tick.
- Phone: with More open, its tabs and Less take the one row; the table
  labels and values sit in two columns; a fields label stays on one line.
- Confirm and Done have their own accessible names; the step boxes take the
  page's colors in light and dark.
- The live demo starts again from the seed in `DEMO_DIR` = demo4/.

Round 11 (Antifeed PM's walkthrough of 227a297, 2026-10-25):
- The Undo toast shows on every tab for its whole time. On a phone it sits
  above the call bar's place (the bar's height once measured, shown or
  not), so it covers no tab and never comes where the bar's Confirm is; the
  page keeps room for it at its end.
- The call bar shows as soon as the card's Confirm (or Done) is not all on
  the screen, and hides only when it is (under the sticky header, or under
  a phone's toast, counts as off). The page reads this at each scroll and
  resize, not with an IntersectionObserver. While the bar shows, the card's
  own Confirm is hidden in place (visibility), so a strip of it never shows
  next to the bar's: one Confirm on the screen in every frame.
- With a More tab open, the phone's More button reads that tab's name and a
  ▾, so the tabs keep one row.
- A crop keeps 10 px on the screen around the red box, on a phone too.
- Flow and Status say a decider's rule and a command in words (the ids in
  Setup and in the tips); the " · " before "8 in the log" is in the text.
- The live demo starts again from the seed in `DEMO_DIR` = demo5/, and in
  demo6/ for Nil's review of slice 4b (no other change).

Round 12 (Antifeed PM's held list after Nil accepted slice 4b, 2026-10-25):
- On a phone the toast sits on the bottom edge, or just above the call bar
  while it shows (--barh); it no longer floats above the bar's empty place.
  Its Undo is on the right and every Confirm and Done on the left, so they
  never meet (V3); tools/round12-checks.ts checks it at every 40 px of
  scroll, on a phone with isMobile true and false and on a desktop, with a
  1-line and a 3-line toast. The reviewer's re-tap probe is tools/toast-retap.cjs.
- Status: "Carry out your call, by ...: goes out in 18 s, when the Undo time
  of your call ends" (one colon).
- On a phone a pair runs to the card's edges, so the crop text is larger.
- round9-checks "1." waits until the card is current for 500 ms and both
  crops are ready, connected and laid out, and prints their size on failure.

Round 13 (Antifeed PM's walkthrough of 1b39bb6, 2026-10-26):
- On a phone the packet box has no side borders, side padding or round
  corners: its text lines up with the card's text, and a pair runs to the
  card's edges in one shape, with no border stubs above, between or below
  Before and After. The crops keep their width, so the crop text keeps its size.
- Status: "Carry out your call (a small program inside Antifeed): goes out
  in 18 s, when your Undo time ends." A held command shows no "since".
- Copy keeps its "Copied" for 1.5 s even when the card draws again in that
  time (a view update about 1 s after a card opens replaced the button, so the
  label went back to "Copy" at once; feedback-checks L39 found it).

Round q1b, package P (Nil's look at the other pages, 2026-10-28, through Antifeed PM; /tmp/af-queue-r1/SPEC.md):
- Tabs: Flow is Policies, Terms is Help. An old link (#flow, #terms-premove) opens the new tab and shows the new name in the address.
- Decided: "the last 200 are shown here". A row opens in place (a fold) to the Premove with its confidence, the Against, the options with the marks of who picked each, the texts that went with the call, what ran (each command of the call: what, who, where it stands), the chat, and "Full packet". The view keeps a decided card slim; its blocks come from GET /api/cards/:id when the row first opens. Drafts and steps show as text. A failed load asks once and shows its error with Try again; a close and a new open ask again.
- Policies: one section per project, "Project: <name>", with its policies file (projects/<project>/policies.ts). A command declares `when` (when the policy sends it) and, for one of several sent at one time, `only` (which call picks it). Policies groups the commands by `when` and says "one command", "one of these, as your call says" or "all of these".
- Accuracy, Policies, Setup and Status open with the same words: "Read only."
- Status: "Quick model runs today: N, cost $X. Antifeed makes a quick model run for a Premove when the Predictor is not available. The day starts at midnight Pacific time."
- Help: what Antifeed is, the path of a packet as a numbered list of 6 steps (the old row of boxes broke into rows that started with an arrow), one packet in the Queue, then the terms. Examples come from more than one source.
- Terms: each term has a one-line definition (its tooltip) and more words for Help. A term in a heading or a label has a dotted underline and the tooltip; a mouse click opens its Help entry, a tap on a phone shows the line with "More in Help". Only the first of each term in a region (.tregion, else a part of the tab) keeps the underline; running text has none.
- G0 on these pages: Predictor, packet creator. tools/pages-checks.ts checks the package.

Round q1, package P2 (Antifeed PM's live walk of 6bfa524, 2026-10-29): agent avatars have 12 px bold initials, white on a circle at 24% lightness (7.6:1 or more for each hue). A project with no Predictor agent (the Inbox) says "a quick model run makes the Premove". A withdrawn Decided row says why once. Decided names the Premove and Against maker with the agent chip. The Inbox's policies file names it "Inbox"; isomux has no name, so its id shows. tools/p2-checks.ts checks the package, with the live view drawn in the copy's page (GET only).

Round Q1, package C (Nil's feedback in the app, 2026-10-28, through Antifeed
PM; /tmp/af-queue-r1/SPEC.md). Checks: tools/card-checks.ts.
- C1: the call bar is at the bottom edge of the screen on a desktop too, not
  in the header; the toast stays in the header, so Undo and Confirm never
  share a place. On a desktop, nothing floats over Your call while any of it
  is on the screen; the bar shows once the whole call zone is scrolled away.
  A sticky Confirm row (review round) covered the Priority chips and took
  their presses (Antifeed Walker), so Antifeed PM ruled (2026-10-29) that a
  short scroll to Confirm, or Ctrl+Enter, beats a press that lands on
  Confirm. Round 10's "one Confirm on the screen, always" now holds on a
  desktop only outside that band; the phone keeps it.
- C4, the walk: New packet needs words Nil typed; a note that equals any
  option's text (the Premove's option, or one a field edit dropped) is
  refused. The pick tag has no dot and stays on one line.
- C2: the fields are the call. The Premove's value has one mark, a purple ring
  and dot, on its chip and on its option (the Premove zone puts the dot before
  its call); Nil's pick is the filled chip. An option is a shortcut: a pill
  says what it fills, the chips it changes flash once, and it shows as picked
  only while the fields hold its values. "Back to the Premove (a)" sits at the
  heading after a change. The fill line, the list of changes, the Options
  heading and the line under Confirm are gone: the reason a locked Confirm
  waits shows beside it only after a press it refused, and in its tooltip.
- C3, G0: the pick and the stand-in name the packet creator ("Demo Worker 2's
  pick").
- C4: Confirm and Later stay together; "Ask <packet creator> for: New packet
  (w), Closer to this option (r)" is a row of its own, and the toast says
  "Asked for a new packet". In the walkthrough copy a code author
  (`walkthrough-creator`) answers the demo kinds' prepare; a code actor's
  `{packet, meta}` result answers its policy's prepare command (only that
  command) with the next version, and a card decided or withdrawn meanwhile
  makes the prepare done, skipped, with no failure card (src/dispatcher.ts
  runCode; test/dispatcher.test.ts "a code author").
- C6, C7: "82% sure" with no bar, the call and the number in bold (G1); the
  Against says by whom (H2 made it a chip; a stand-in from the pick names the
  packet creator there too).
- C8: a text block over 600 characters shows its first paragraph (cut at a
  sentence within 400), and the whole block, and any diff over 40 lines, is
  behind one "Full packet" toggle, closed. A tall ask image stops at 480 px.
  The walkthrough's Wall Game board has a long task, as d9ff7318. The check
  fails when a packet zone is over 900 px at 1400 x 1000.
- A zone heading and its "by" or "from" (with an agent chip, H2) sit on one
  baseline (Antifeed Walker, live, phone); a check measures it on both sizes.

## 14. Slice 7: the Inbox (Nil's go, 2026-10-26, relayed by Antifeed PM)

Nil's asks and pages come into the queue as cards. The Isomux Inbox keeps
working; the first place that answers closes the card or the ask in the other.
The office side is isomux task 4a1e58c9 (an app reaches its owner's member's
asks and pages, behind a switch only Nil sets). Until it ships, Antifeed's
side runs against a fake office with the same routes and shapes (read
2026-10-26 in ~/nil/isomux shared/types.ts `AskEntry`, `PagerEntry`,
shared/contract-shapes.ts `AskReplyReq`, server/routes/table.ts).

### 14.1 Project, source, events

- A project of its own, `projects/inbox/policies.ts` (`project: "inbox"`):
  the Inbox is an office feature, not the isomux SDLC, and it goes live
  without the triage policy. **(choice)**
- Actors: `office` (code: the app calls the office with its app token),
  `nil` (human), `consult` (Isomux Consult, the same agent as isomux's).
- Source `inbox` (kind `isomux-inbox`), in the app, every 10 s **(choice)**:
  `GET /api/asks` and `GET /api/pager?state=open`. Its state is the
  projection of its logged events, as the board source's. It drops every ask
  with `secret` before it emits anything. To name the asker and its room it
  reads the agent list (`/agents?back=1`) and stores the names in the event.
- Events (`from: "inbox"`): `inbox.ask.opened` (new or first read),
  `inbox.ask.changed` (`updatedAt` moved: the agent edited it),
  `inbox.ask.closed` (gone from the listing), `inbox.page.opened`,
  `inbox.page.changed` (a raise with the same key: new title or body),
  `inbox.page.closed` (acked, resolved, or gone; the state says which). The
  source cannot tell who closed an ask (a reply in the Inbox, or the agent's
  delete): the listing only loses it.

### 14.2 Policy `ask`: a decision card

- On `inbox.ask.opened` the policy opens a card with its own packet (it is
  the author; no prepare command):
  - question: the prompt's first line (up to 140 characters);
  - blocks: the whole prompt (markdown, as data); `fields` with the agent,
    its room and the time asked; a `link` block for the ask's office page
    when it has one; the ask's terminal commands and files as text, with
    "open the Inbox to run or open them" (Antifeed has no terminal panel);
  - options: one per ask option, `fill: {action: "reply", text: <option>}`;
    `recommended`: the option the agent recommends (the author's pick: shown
    to Nil, hidden from the predictor, as for every card);
  - meta: source "Isomux Inbox", raw = the agent's chat
    (`https://office.example.com/agents/<agentId>`), createdBy = the agent.
- Answer: `action` (`reply`, `dismiss`, `file-task`) and `text` (the reply,
  or the note for a dismiss or a filed task; up to 4000 characters; needed
  for a reply). `primary: ["action", "text"]` **(choice)**: another option is
  a changed call, so the match rate means "the Premove sent the same words".
- Decider: `nil` with Isomux Consult's Premove (criteria file
  `projects/inbox/ask-criteria.md`). `autoAllowed: false` **(choice)**: a
  reply reaches the agent as Nil's own message, and an agent never speaks as
  Nil (Nil, 2026-10-23), so this kind never leaves Nil.
- On `card.decided` it issues `inbox.reply`, `inbox.dismiss` or
  `inbox.file-task` to `office` with `{askId, text}`, at-most-once (a sent
  message cannot be taken back, and a second send is a second message). The
  dispatcher holds it for the call's 24 s Undo time, as every command of a
  call (round 9).
- Undo: inside the 24 s it cancels the command, as today. After the send it
  is refused: "the reply went to the agent; it cannot be taken back". This
  needs one engine rule: a policy flag `undoUntilSent` makes Undo of a
  decided card 409 once its command is delivered. **(engine)**

### 14.3 Policy `page`: an action card

- On `inbox.page.opened` it issues `inbox.page` to `nil`: an action card with
  the page title as the question, the body (markdown, as data), and `fields`
  with the source (agent or app), its room, raises and first raise time.
- Done (held 24 s, as every action) gives `command.done`; the policy then
  issues `inbox.ack` `{pageId}` to `office`, at-least-once (a second ack is a
  harmless 409). "Could not do it" sends no ack: the page stays open in the
  office, which keeps repeating it.

### 14.4 Withdraw rule

- A card whose ask or page is gone from the office withdraws, with a reason
  in the event and on the Decided tab **(engine: `withdraw` carries a
  reason)**:
  - ask closed: "answered in the Inbox, or taken back by its agent";
  - ask changed: the card withdraws ("the agent changed the ask") and a new
    card opens with the new text (a new Premove);
  - page acked: "acked in the Inbox"; resolved: "resolved by its source";
    gone: "gone from the office"; changed: withdraw and a new card, as for
    an ask.
- A call whose command still waits in its Undo time when the ask closes: the
  policy cancels the command, and the Decided tab says "not sent: the ask was
  closed in the office first". A command that meets a 404 at the office (the
  ask closed between the last read and the send) is done with
  `{notSent: ...}`, the same words, not a failure card. Any other office
  error is `command.failed`, which opens a command-failed card as today.

### 14.5 Switches and the fake office

- `src/config.ts` names projects by constant: `INBOX = true` (the slice's
  goal) and `TRIAGE = false` (Nil's go on the switch). The live log is
  `live/` with the projects that are on; the demo (`DEMO`) stays for test
  copies and the walkthrough. SWITCH.md changes one line: triage joins a
  live log that already holds the inbox (a new project's first read).
- With the app token but no reach yet, the office answers 403. See 14.8
  for how the source tells the cases apart (as built after the review).
- `tools/fake-office.ts`: `GET /api/asks`, `POST /api/asks/:id/reply|dismiss|file-task`,
  `GET /api/pager`, `POST /api/pager/:id/ack`, `GET /agents?back=1` and
  `POST /api/app/message`, in memory, with a control route to
  add, edit and close asks and pages (the reviewer plays Nil and the agents
  with it). The walkthrough copy uses it in-process with a seed: two asks
  (one with options and a recommendation, one free text) and one page.

### 14.6 Not in this slice

The secret form (secret requests never come in), the ask's terminal panel
and editor affordances (shown as text only), pages to other members, and
asks for another member.

### 14.7 As built (Antifeed Builder, 2026-10-26)

Antifeed PM's go on 461dead (2026-10-26) changed two things: `primary` is
`action` + `choice` (the option the words came from, or "own words"), and an
ask's affordances show on the card (files as image or file blocks, commands
as code lines with Copy, edit files as one line).

Engine changes (the reviewer reviews them):
- `withdraw` and `cancel` take an optional `reason` (at most 500
  characters); it goes in `card.withdrawn` / `command.cancelled` data, and
  the Decided tab shows it in place of the cause it reads today.
- `Policy.derived`: values made from a call and its packet, never stored.
  `outcome()` compares them like fields; a `primary` field may name one.
  The load check refuses a derived name that is also an answer field.
- `Policy.undoUntilSent` (words): Undo of a decided card is 409 with those
  words once a command of the call is past `issued` and not cancelled
  (`Engine.sentOf`).
- An `issue` to a human may carry `meta` (source, raw, createdBy, priority,
  effort; strings only); the author and the time stay the engine's.
- A withdrawn action card cancels its own action (if still issued). An
  action card whose Done or Could not do it is held is not withdrawn, and a
  policy cannot cancel its action: the mark goes out after its Undo time.
- Code actors get a run context: `run[handler](command, {office, card})`.
- Blocks `code` (text) and `file` (blob, name, size); blob types pdf and
  octet-stream (20 MB); every blob is served with `nosniff`.
- `checkRules` says "needs words" for a plural label (was "needs a words").

Not engine: src/inbox.ts (the source), src/fake-inbox.ts (the fake office,
served under `/fake-office` only in a walkthrough copy), projects/inbox
(policies `ask` and `page`, the office actor, the walkthrough seed and
stub, ask-criteria.md), the Office client's asks, answers, pages, ack and
files, and the page (a long text field is a text box, no note box when the
policy says `noNote`, no subject word when `subjectLabel` is null, Decided
says what a call that cannot be taken back became, Status says first when
the Inbox has no reach).

The installed `antifeed-consult` skill needs the one line this commit
changes in projects/isomux/antifeed-consult/SKILL.md (a text field takes
text) before the Inbox goes live.

Checks: test/inbox.test.ts (14), tools/slice7-checks.ts (17, on a
walkthrough copy against the fake office). feedback-checks L65 and round9
"11." now set the project count they test, because the walkthrough copy
holds two projects (demo and the Inbox).

### 14.8 Review round 1 and the office side (Antifeed Builder, 2026-10-26)

Antifeed Reviewer approved the engine part of 5b1fc47 and asked for three
fixes; Isomux Worker 1 gave the office side of 4a1e58c9 (designed, not
shipped; read from its code, not run). Not engine:

- The ask's link stays only as an office path: it starts with "/", not
  "//", has no backslash or space, and joined to the office URL it keeps the
  office's origin (`officePath`). The source drops any other link; the
  policy checks again.
- Member filter: the source drops an ask whose `memberUserId` is set and is
  not Nil's, and a page whose `targetUserId` is not Nil's. The office lists
  every page in Nil's rooms to the app, not only his (4a1e58c9).
- The ask's safe default is still a filed task. The office's file-task
  (isomux asks.ts) puts a task on the board of the agent's room, tells the
  agent, and closes the ask; the comment says so, and the button says it
  too (`Policy.fallbackHelp`).
- The reach (4a1e58c9). Pages, one page by id and the ack work for an app
  with a live owner agent, with no switch. The asks and their files need
  Nil's per-app switch (Apps page). Each refusal is the same 403
  (`forbidden`), so the source reads in this order: `GET /agents` (403: the
  app has no live owner agent; Status says so and nothing is read), the
  pages (as before), then the asks (403 with a live owner: the switch is
  off; Status says "Nil has not turned on Inbox access for this app (Apps
  page, ⋯ menu, Let it answer my asks)", and the pages still come). A refused read opens and closes nothing.
- Part N (Nil's ruling, isomux task 4dce5b39: apps get no asks switch;
  Antifeed PM, 2026-10-30): Nil's own API token, given to the antifeed app
  by a secret request named ANTIFEED_NIL_TOKEN (the app gets it in its
  environment and restarts). With it, the asks, their files, the answers,
  the pages and the acks go as Nil. Without it the asks are not read (a
  state: Sources says "asks need your API token: see the secret request in
  your Inbox"), no answer is sent, and the pages come with the app token. A
  401 or 403 with the token is "the office refused your API token
  (ANTIFEED_NIL_TOKEN) ...": a Sources alert, and a Blocked failure card on
  an answer or ack. The token is never logged or printed. The app token
  cannot open a secret request (the apps reference), so an agent opens the
  one request, with `app: "antifeed"` and `member: "Nil"`.
- 409 `ask_busy` (another answer to the ask is going out from the Inbox):
  the office actor tries again, 3 times 2 s apart. The office refused the
  earlier tries, so this sends at most once. Then a 404 is "not sent", and a
  third 409 is a failure card that says it was not sent.
- A file over the 20 MB that the blob store keeps is not read: the listed
  size is checked first, then the length header, then the bytes as they
  come.
- The page: an option says what it fills without its own label again
  ("fills reply, with these words"); the option help speaks of the text box
  when the policy has no note; the ask packet has no "Asked by" row (the
  head names the agent); a page's chip is "Page for you"
  (`Policy.actionLabel`); a page raised again while Nil's Done was held is
  withdrawn with "Your Done on its earlier card acked the page".
- The fake office has the switch and the owner apart (`POST
  /fake-office/control/reach {switch, owner}`), `ask_busy` (`POST
  /control/ask/busy {id, on}`), and the office's error shapes.

Checks: test/inbox.test.ts (21), tools/slice7-checks.ts (22).

### 14.9 Walk round 2 (Antifeed Builder, 2026-10-26)

Antifeed PM walked 35ed143 on a walkthrough copy. Engine changes (the
reviewer reviews them):

- The code stand-in gives a whole call. Each tier's call must pass the
  check that Nil's call passes; a tier whose call does not gives way to the
  next. A vote carries no words, so a vote for a call that needs them
  ("reply") takes them from an option that makes the same call, the author's
  pick first. The author's pick keeps its option's words. The last tier is
  the policy's safe default (`safeDefault`). The engine's own guard
  (`codeStandin`) also falls back to the safe default, never to an empty
  call, for every policy.
- `issue` may carry `about` (`CommandAbout`: a title and up to 8 rows of
  strings): the command in plain words. It is kept on the command record.
  Status shows it in place of the type and ids, and the command-failed card
  uses it: "<title> did not go out: <cause>", the rows, and the ids in a fold
  "Ids, for a bug report". A command without `about` keeps the old card.
- A code actor may throw `Blocked` (src/policies.ts): a cause that holds
  until someone fixes it. `command.failed` then carries `blocked: true`, the
  card says a new try fails the same way, and its Premove is "drop", not
  "retry".
- `repacket` (OutItem): a new packet for an action card the policy issued,
  while Nil has not marked it (not held, still open). It logs `card.packet`
  with the next version.
- `CommandDecl.failedWords`: what "Could not do it" did, for Decided.
  Status lists no failed command that is Nil's own "Could not do it" on an
  action card.
- `Policy.createdByLabel` ("From", tip "Who sent it"), and image blocks may
  say `wide` (the card's full width).

Not engine:
- The office actor names the cause of a 403: with a live owner agent
  (GET /agents answers) Inbox access is off, else the app has no live owner
  agent. Both are `Blocked`. Each ask answer and page ack has its `about`.
- A page raised again with the same words (a new count) gets its card's
  packet again in place; with new words, a new card as before. A card Nil
  marked stays as he saw it.
- The view carries `inboxAlert` (access off, no owner, a failed read); the
  queue shows it first.
- Page: chips "Ask for you" and "Page for you"; a kind names its project
  only when two loaded projects have a kind of that name ("Triage
  (Isomux)"); a page card has "Details", not "Steps", and the chip's color
  on its left border; when every option fills the same way, the help line
  says it once and the rows do not; "Pick an answer"; timers in words.
- Confirm to the next card: 22 to 59 ms from the click or key to the next
  card drawn, on a fresh walkthrough copy with the inbox seed, load average
  about 4 (2026-10-26). The walk's 338 to 453 ms includes its press helper's
  10 mouse-move steps and 250 ms wait after the click.

Checks: test/standin.test.ts (34), test/inbox.test.ts (25),
tools/slice7-checks.ts (32).

### 14.10 Walk round 3 (Antifeed Builder, 2026-10-26)

- Desktop header: the dock is two fixed slots, the toast in the left half
  and the call bar in the right half. Neither moves or changes width when
  the other shows, hides or changes, so the toast's Undo stays where it was.
  Each keeps one line: the text ends in an ellipsis and the buttons never
  wrap. The bar's "ready in a moment" hint is not shown in the header; the
  card's own line under Confirm says it.
- The failed-command card has no subject word in its head (no command id),
  so a phone page keeps its width; its source reads "Antifeed".
- Asks with 5 or more options: none reach Antifeed. The office refuses an
  ask with fewer than 2 or more than 4 options (isomux server/asks.ts,
  ASK_OPTIONS_MIN and MAX, read 2026-10-26), and a card holds 2 to 4. The
  fake office now refuses them too. Any other count stays a text line, as a
  guard, and names the agent's pick.
- A stand-in vote that needs words takes them only from the author's pick,
  and its reason says the number backs the call, not the words. With no
  pick, the next vote that is a whole call, else the safe default.
- A wide image shows at its own size up to the card's width, never larger.
- The retry rule's label names the rule that gave the call ("no retry
  while the cause holds", "drop a failed retry", "retry a first failure").
- An action card read once stays read through a new version (a page raised
  again): no "Version 2" chip, and Done stays ready. A page says "Read the
  page, then press Done." and its bar "Your part: the page".
- The page's color is #be185d, clearly apart from an action's in light and
  dark. Decided says "no basis" for a Premove with no basis.

Checks: tools/slice7-checks.ts (37): 8c checks that the toast's Undo stays
put for 2 s after a mouse Confirm, with the call bar showing and not; 8b
checks the failure card's width on a phone (scrollWidth) and an image's
size.

## 15. Effective decisions (Nil, 2026-10-26, relayed by Antifeed PM)

Nil's definition: an effective decision is one where two reasonable humans
could disagree, or where there is one correct answer but a model may not get
it right. Both need his judgement. The PM approved this rule (2026-10-26).

- `effective(line)` is true when the outcome is `edited` or `changed`; or
  unpredicted (no Premove, or a safe default, which is never filled in); or
  `matched` with `calibrated(line)` < `EFFECTIVE_MIN_CONFIDENCE`.
- `calibrated(line)`: the safe estimate (Wilson lower bound, 95%) of the
  Premove's confidence band, in its own calibration row (policy, predictor
  version, informed or not, stand-in tier), counted over Nil's lines decided
  before it. A band with no earlier lines gives 0. "Before it" keeps a call's
  verdict as it was when Nil made it: a later call never changes it. Lines
  at the same time are not before each other.
- `EFFECTIVE_MIN_CONFIDENCE` = 0.9, one constant in `src/config.ts`, not per
  policy.
- The lines that count are the same as before: by Nil, not imported, not
  undone. A band reaches 0.9 only after 35 clean matches in a row (35 of 35
  gives 90.1%; 34 of 34 gives 89.8%; 49 of 50 gives 89.5%). Until then every
  confirm counts as needing Nil, and eDPM is close to DPM.
- `src/metrics.ts` `weekly()`: `effective` uses this rule. New counts:
  `changed` (edited and changed), `unpredicted`, `unsure` (matches under the
  minimum) and `sureConfirms` (matches at the minimum or more). eDPM is
  effective / active minutes; DPM and the match rate do not change. The
  weeks are worked out again from the decision log at each read, so past
  weeks changed on 2026-10-26.
- The Accuracy tab: the column "Changed calls per minute" is now "Calls that
  needed you, per minute", with the tip "Calls where two reasonable people
  could disagree, or where a model may get it wrong (your definition,
  2026-10-26): every call you changed or edited, every call with no Premove,
  and every confirm of a Premove that was less than 90% sure by its record."
  Per policy, one line: "N calls you confirmed at 90% or more: candidates for
  a threshold."

### 15.1 Also in this round (Antifeed PM's walk of slice 7 round 3, 2026-10-26)

- The code stand-in: when the most voted call cannot be made whole (a vote
  for reply on an ask with no author's pick has no words), the stand-in
  gives no basis and the safe default, never a less voted call. Calls tied
  at the most votes are all the vote's call. With fewer than 3 past calls,
  the author's pick, else the safe default, as before.
- A stand-in's reason and Against say a value as the page says it ("file as
  a task", not "file-task").
- A decision's toast puts the card's title first and the call after it
  ("<title> · Decided <call>"), so its Undo says which card it is for when
  the header cuts the text.
- A walkthrough copy (`ANTIFEED_WALKTHROUGH=1`) is always in demo mode. The
  go-live commit 9f05a22 set `DEMO = false`, and copies of it loaded only the
  Inbox; `src/config.ts` now has `DEMO = OFFICE_DEMO || WALKTHROUGH`.
- `tools/edpm-checks.ts`: the toast's title at 1280 px, the weekly counts
  after three calls, and the Accuracy tab's column, tip and threshold line
  on a desktop and a phone.
- `tools/undo-steady.ts` (Antifeed Reviewer's check): after a mouse Confirm,
  the toast's Undo does not move from 0 to 2 s, and a click at its first
  place is an Undo.

### 15.2 Polish (Antifeed PM's walk of 2ab274c, 2026-10-26, UI only)

- A decision's toast has two parts, the card's title and the call. When the
  header is too narrow, the title ends in an ellipsis and the call stays
  whole. On a phone both wrap, in up to three lines.
- A call with no Premove says "no basis" everywhere: the Accuracy tab, the
  Decided tab and the card (as before, "No basis" at the start of a line).
- A stand-in's calibration row reads "Stand-in: a quick model run", in lower
  case after the colon.
- While no kind can be 90% sure (no week has a sure confirm and no band's
  safe estimate is 0.9 or more), one line under the weekly table says:
  "Every confirm counts as needing you until a kind has 35 matching calls in
  a row at the same confidence."

Checks: tools/edpm-checks.ts (24).

## 16. Slice 8: Wall Game triage (Nil, 2026-10-26, relayed by Antifeed PM)

Nil: "Can we add tasks from wall game room to antifeed". Wall Game PM agreed
to the contract below (Antifeed PM, 2026-10-26). Antifeed reads the Wall Game
board and messages Wall Game PM; it never writes the board.

### 16.1 Project, switch, source

- `projects/wallgame/policies.ts`, project `wallgame`, live on its own
  constant `WALLGAME` in `src/config.ts` (false until Antifeed PM's go after
  review and walk), without isomux triage.
- Source: the board of the Wall Game room (`51c2d889`), read only, through
  the board source isomux triage uses (`src/board.ts`, every 60 s). Two
  changes to that source: a task snapshot carries its description and its
  assignee, and a known task with no priority that leaves the listing is read
  one by one like a P0-P3 task (today only P0-P3 tasks are).
- Actors: `nil`; `consult` (Isomux Consult); `wgpm`, a code actor that
  messages Wall Game PM by its id (`WALLGAME_PM_ID`,
  `agent-0000000000002-aaab`; F4 below).

### 16.2 Which tasks get a card

A task qualifies when its status is `open`, its priority is P0-P3 or none,
it has no assignee, and its description has no call line of Nil's (16.3).
e8d26610 is `in_progress`, so the status rule skips it. The first read
gives every task that qualifies a card (29 of the 37 listed tasks on
2026-10-26, read 13:20 UTC); later reads open cards only for new tasks, and
for a task that qualifies again after it stopped (reopened, unclaimed).

A waiting card withdraws, with its reason in words, when its task closes,
leaves the room, is claimed (an assignee), moves to P4, or gets a call line
of Nil's: "Nil decided it on the board." A change to a waiting task's
title, description or priority replaces the card with a new one that shows
the task as it is now, as an ask's edit does (a decision card takes no new
packet version). A decided card never withdraws.

### 16.3 Nil's call line (question 1)

Wall Game PM writes each call at the top of the task's description as
`Nil, <YYYY-MM-DD>: <call> [<priority>]. <note>`.

- A (recommended): a call line is a line that starts with `Nil, <date>:`
  and then one of the five call words. On 2026-10-26, two open tasks
  start with `Nil, <date>:` but hold Nil's reports, not calls: cfc6135a
  ("Nil, 2026-07-29: after beating a campaign level...") and b0763e9c
  ("Nil, 2026-10-05: the old Wallwars site barely gets played..."). With
  A, both get a card.
- B: any line `Nil, <date>:` at the start, as in the brief. Those two tasks
  get no card, and they have no call either.

### 16.4 The card

- Policy `wallgame-triage`, kind name "Triage" ("Triage (Wall Game)" once
  isomux triage is live too). `autoAllowed: false`.
- Packet: made by code from the task, with no author agent: the title as
  the question, the description, priority, who filed it and when, and the
  office's address. No author's pick, so no rewrite or refine.
- Answer: the isomux triage shape. `choice`: go, design, hold, backlog,
  obsolete; `priority`: P0-P3 for go, design and hold, none for backlog and
  obsolete; Nil's note. Primary field: `choice`. Safe default: backlog.
- The Call field's help line, under the choices on every Wall Game card:
  "go allows the work up to a deploy, push, prod write or bot restart.
  Those still need your word in an ask."
- Premove: Isomux Consult, with `projects/wallgame/triage-criteria.md` (what
  Nil cares about in Wall Game, from the board and the room's memory). No
  precedent yet: the first Premoves are mostly stand-ins or no basis, and
  29 cards at the first read cost up to 29 quick model runs (each capped at
  $0.50; about $3 in all if a run costs $0.10, as Chief Researcher measured
  one on 2026-10-22; not checked here).
- The antifeed-consult skill covers every project Antifeed sends it, not
  only isomux; it reads the Wall Game board and code (`~/nil/wallgame`)
  read only. Antifeed PM copies the changed skill into place.
- Wall Game asks (daily-video approvals, Wall Game PM's A/B asks) stay
  asks: they come through Nil's Inbox (section 14).

### 16.5 The command (question 2)

`wallgame.apply`, actor `wgpm`, at-most-once. It waits out the call's 24 s
Undo time, and then the burst: calls go together once Nil has made no new
Wall Game call for 3 minutes (isomux triage's burst). One office message to
Wall Game PM per burst, through the app's token (`POST /api/app/message`
with `targetAgentId`). Per call, one block:

```
<task id> "<title>"
Call: go P1 (Nil, 2026-10-26 6:41 AM PT)
Note: <Nil's note, verbatim, or "none">
Check: curl -s 127.0.0.1:21042/api/cards/<card>/context
```

The head says the calls are Nil's, made in Antifeed: write each to the
board as its call line, and do the work in priority order. "go" means do
it, up to the line in 16.4. The office labels the message as the app's; the
Check line lets Wall Game PM read the same call in Antifeed, read only.

- A (recommended): `wgpm` is a code actor. The command is done when the
  office takes the message, as agreed with Wall Game PM. This needs one
  engine change: a code handler may take all of its due commands of one
  type in one run (`batch: true`), so a burst is one message.
- B: Wall Game PM is an agent actor, as the Curator is for isomux: it
  starts each command and reports when the board line is written, so a
  call it never writes becomes a failure card after a timeout. More
  certain, but Wall Game PM must take up Antifeed's command protocol, which
  is not in the agreed contract.

A failed send gives one failure card in plain words (F2, F3 below).

Antifeed Reviewer's design review and Antifeed PM's choices (2026-10-26):

- F1, a call that is no longer true does not go out (as an ask's reply,
  slice 7). At each board read, a decided call that has not started to go
  out is cancelled when its task closed, left the room, was claimed, moved
  to P4 or got a call line of Nil's; Decided says "Not sent." and why. When
  the task's title, description or priority changed, the call is cancelled
  ("Not sent. The task changed on the board after your call. A new card
  shows it as it is now.") and a new card opens. Just before the send,
  `sendCalls` reads each task again and drops a call by the same rules
  (result `notSent`); the next board read opens the new card of a changed
  task.
- F2: a 403 (the app has no live owner agent) and a 404 (no such agent)
  are `Blocked`, with drop as the Premove. Any other 4xx: the office did
  not take the message; retry is the Premove. No answer, or a 5xx: the
  message may have gone (`MaybeSent`), so the card says "may have gone:
  check with Wall Game PM", with drop as the Premove.
- F3: all commands of the burst are logged delivered and started before
  the send, and the one result sets them all done or all failed. A failed
  burst gives one failure card that lists its calls; "Send them all again"
  reissues all of them, so they go in one message again. After a crash
  during the send, the next start fails the burst's started commands as
  "may have gone" (one card, drop as the Premove) and sends nothing again.
- F4 (Antifeed PM's choice): Wall Game PM by its id, in a constant. When
  that id is not a live agent in room `51c2d889`, the send is `Blocked` and
  goes to no one. A new id is a one-line change.
- P1: the Check line is a read (`GET /api/cards/:id/context`, no member
  header). Nothing in the message tells Wall Game PM to change Antifeed.
- P2: the head says that the Antifeed app sends calls that Nil made in
  Antifeed, and that Nil did not write the message. Titles from the board
  are in quotes, in the blocks.

### 16.6 Undo (question 3)

- Recommended: as an ask's reply. Undo works until the message goes; after
  that the Decided tab says "Your call went to Wall Game PM; it cannot be
  taken back." A correction is a new message from Nil to Wall Game PM.
- Other: Undo after the send opens the card again, and the next call's
  block says it replaces the earlier one.

### 16.7 Checks and review

Antifeed Reviewer reviews the slice (it messages an agent): the board
source change, the policy, the batch handler and the message text.
Walkthrough copy: the fake office also serves a Wall Game board with seeded
tasks and records the messages sent to Wall Game PM, so the checks see the
exact text without a real message.

### 16.8 As built (Antifeed Builder, 2026-10-26)

Antifeed PM's go on 2263b85 (2026-10-26): A for the call line, A for the
send, and the Undo rule of 16.6. Its addition: since Antifeed reads the board
anyway, it shows whether each sent call's line is on the board.

- `projects/wallgame/`: `policies.ts` (project "Wall Game", actors, the
  board source, `sendCalls`), `triage.ts` (the policy, the call line rule,
  the message), `triage-criteria.md` (from the board and the room's memory,
  read 2026-10-26), `walkthrough.ts` (the fake board's seed and the consult
  stub). `WALLGAME = false` in `src/config.ts`; a walkthrough copy always
  has the project, on the fake office's Wall Game board.
- Engine: `ProjectDef.runBatch` (a code handler that takes a burst in one
  run; the dispatcher logs each command delivered and started before the
  run, so an Undo after that is refused, and one failure fails the run's
  commands); `RunContext.api` (Antifeed's own address, for the Check line);
  `Policy.landing` (the calls that went out, and when each landed);
  `ProjectDef.name` (the project's plain name in a kind chip).
- The board source: a task's description comes with it, and a known task
  with no priority that leaves the listing is read one by one.
- A sent call lands when the task's description has a call line with its
  call word, dated on or after the call's day (PT). Until then the task gets
  no new card, since Wall Game PM may change the task before it writes the
  line. Status lists each sent call ("Calls sent"), and Decided says after
  the send: "Sent to Wall Game PM ...; it cannot be taken back." and then
  "Not on the board yet.", "On the board <time>." or, 24 h after the send
  without its line, "Not on the board: Wall Game PM has not written its
  line in 24 h."
- While a call waits for the burst, Decided says "Goes out once you make no
  new call of this kind for 3 minutes; you can undo it until then."
- In the message, a field's later lines are indented by two spaces, so a
  note of several lines shows where it ends.
- F1-F4 as 16.5 says. Engine: `MaybeSent` (src/policies.ts) next to
  `Blocked`; `command.started` of a batch run carries the run's ids
  (`batch`), so the built-in failed-command policy opens one card for the
  run and its retry or reassign reissues every command of it.
- B1 (Antifeed Reviewer's review of 6c0aa72): a failed call holds its task
  (no new card) while its failure card waits, so a retry never races a new
  card. When Nil drops it, the built-in policy logs `command.dropped` for
  each command whose type sets `notifyDrop`; the Wall Game policy frees the
  task and opens a new card if the task still waits. If the call reached
  Wall Game PM after all, its call line withdraws that card. A retry that
  `sendCalls` drops for a change the board source saw before opens the new
  card at once. The office send has a 30 s timeout (`SEND_MS`); no answer
  in that time is "may have gone".
- Walk of 4118e95 (Antifeed PM, 2026-10-26), with Antifeed Reviewer's plan
  for its blockers:
  1. A failed command is sent again at most once (a reissue that an Undo
     cancelled does not count). A command records the one it sends again
     (`reissueOf`). The built-in policy has `undoUntilSent`, and `sentOf`
     follows the chain (`Engine.callsOf`), so the Undo of a failure card's
     call is refused once its retry went out. An Undo before then cancels
     the retry (`command.cancelled` with `undone`), and the failed call
     holds its task again. A retry of a call that no longer holds its task
     (dropped or taken back) is cancelled: "Not sent. This call was dropped
     or taken back before, so it does not go out again."
  2. A card's sends follow the chain to its last command, so Decided,
     Status and the landing line show the retry's result. Status "Failed
     commands" leaves out a failed command that was sent again, and one Nil
     dropped. Decided says "May have gone: ..." for no clear answer, and "A
     card for it is in the queue." only while that card waits ("You dropped
     it." after a drop).
  3. Every office answer before the send goes through F2 too: a 403 on the
     agent list or a task read is `Blocked`. Any other read error is "could
     not read ..., so nothing was sent". The fake office fails only the send
     on `POST /control/sendfail {mode: 403|404|502|"hang"|null}`; a
     walkthrough copy gives up on a send after 5 s.
  4-7. A failed-command card whose about has Nil's words (`one`, `many`,
     `label`, `name`, `ids`, `to`, `noReassign`) speaks only those: "Your 2
     calls to Wall Game PM may not have gone out. The office gave no clear
     answer; check with Wall Game PM before you send them again." Each call
     is a row "Call: <task title>", and the ids and the raw cause
     (`detail`) are in the fold. The buttons are "Send them again" and
     "Drop them", as the note says. `packet.limit` leaves out reassign and
     New actor, and the engine refuses them on that card. The F4 card says
     what happened and nothing about code. The rule "no retry when it may
     have gone out" is named.
  8. The late-Undo toast cuts only the card's title; the warning stays whole.
  9. Accuracy names a kind as the queue does (`kindName`).
  10. `Policy.noAuthor` and `notePlaceholder`: on a Wall Game card the note
     "goes to Wall Game PM as you write it", and a no-basis Premove says "no
     prediction came from the consult agent".
  11. One call: "1 triage call ... on a Wall Game task ... Write its board line".
  12. Desk: Previous and Next stay at the right of the head's first row.
     Phone: the head is the kind with Previous / Next, then one fold with
     the board priority and the age (the task id, filer and source inside).
     Decided: after a note, the send line is a line of its own. Status: a
     call's line has no quotes.
- The antifeed-consult skill covers every project, Wall Game included (no
  author: it asks nobody, and tells Nil what it could not check).

Checks: test/wallgame.test.ts (21: F1 twice, F2, F3 twice, F4, B1 twice,
the send timeout, the walk's blockers 1-3 and the one-call head), a board
source test, tools/slice8-checks.ts (19, about 7 minutes: the burst;
F1 and the head on the page) and tools/slice8-fail-checks.ts (one copy per
mode: 403, 404, hang 11 each, 502 18 with the retry).


#### Walk 2 follow-up (Antifeed PM, the Walker's second walk of 2c0f464, 2026-10-26)

1. A drop keeps the Undo time of every other call (Antifeed PM, 2026-10-26:
   the page promises an Undo on every call, and a mis-tap on Drop is the
   likely case). The built-in policy holds a drop of `notifyDrop` commands
   for CALL_UNDO_MS (24 s, the same as ACTION_UNDO_MS and CALL_HOLD_MS) with
   a wake (`S.drops`); only at that wake does the owner policy get
   `command.dropped` and free the task. Inside that time, Undo
   (`card.undone`) deletes the held drop: the failure card comes back whole
   and no task gets a new card. After it, the engine refuses the Undo
   (`Engine.freedOf`: "Your drop freed its task already; it cannot be taken
   back."), as for a sent retry. Decided says "Frees its task when its Undo
   time ends; you can undo it until then.", and after it "Your drop freed
   its task; it cannot be taken back. The task may have a new card." with
   no Undo (`dropping` and `freed` on the card in the view). A log made
   before this change with a drop in it replays with a difference (the
   drop is now a wake); the live log had no drop (checked 2026-10-26).
2. Failure card words: the note says "stays with your call in your decision
   log"; a call's row is "Task: <task title>"; the retry rules name the
   card's own button, and "them" on a card of more than one command; a
   card names "a retry rule: <rule>", and Accuracy names the four rules in
   the same words.
3. Phone head fold: its summary names what the fold opens, by its items
   ("task id, link").
4. The Undo toast has no card title: "Back in the queue with your call."
   and, late, "What the call started already ran, and stays done."
5. A disabled Previous or Next has no key hint.
6. Phone head fold: the fold has no margin and sits right under the head's
   row; its summary keeps a 44 px tap height that runs down over the next
   line, and a link inside keeps 44 px by padding that runs into the row
   gaps. Measured on a 390 px phone, 2026-10-26: from the arrows to the
   summary text 35 px before, 9 px after; from the open fold's link text
   to the question 36 px before, 18 px after.

## 17. Predict bursts (Antifeed PM, 2026-10-26, after the slice 8 go-live)

At the go-live, 32 Wall Game cards opened at once. Antifeed sent their 32
predicts in two office messages; Isomux Consult got 31 of them in one turn,
read all 31 before it started any, and none started within 120 s. The 31
claude -p stand-ins then ran at once in the app's service (MemoryMax 512 MB):
the journal shows a 512 MB memory peak and 1.3 GB in swap, and none answered
in 120 s. 31 cards went to Nil with no basis.

- The dispatcher hands each actor at most PREDICT_IN_FLIGHT (3) predicts:
  delivered, or started less than answerMs ago (one started longer ago stays
  open for a late answer, but holds no place). The rest wait, issued. A
  predict whose card waits for its Premove goes before a predict again.
- The start timer runs from the delivery (`deliveredAt`). A predict that
  waits answerMs in the queue gets the stand-in ("had other cards to predict
  first"). A predict to an agent that is not live fails at once, so its
  card gets the stand-in at once; after another send error (the office
  restarts) the dispatcher sends it again at its next tick.
- At most STANDIN_AT_ONCE (2) stand-ins run at a time; a card over that
  waits for the next check. Measured on real Wall Game inputs, sonnet,
  2026-10-26: 1 run 14 s; under a 512 MB cap, 2 at once 12-14 s, 4 at once
  15-18 s, 8 at once 61-70 s each.
- Predict again: an open card whose Premove is the code stand-in with no
  basis, and whose version Nil has not seen, gets one more predict (once per
  version: the card has exactly one predict for it, closed). Its answer is
  the Premove (a late answer, not seen). A card Nil decides meanwhile keeps
  his call (its predicts close). A predict again that its actor does not
  start in startMs from delivery is cancelled, and the card keeps its
  stand-in; in the queue it waits with no limit.

## 18. Shape cards, round 2 (Nil, 2026-10-29 evening, relayed by Antifeed PM)

Nil's words on the 27 shape cards: "there's a wall of text just to get to
whether a line should be short or shorter"; "the line length is not even
something that i need to choose on. it's a trivial difference without
impact"; "Why am I being shown file names and code lines?? i don't operate
at that level. i should have never been shown code"; "when i alternate
between option 1 and 2, the 'back to premove' button disappears, and the
rest of ui below it janks up and down. ugly"; "what is the Against even
saying, it's referencing some line that i have no idea what line it's
talking about". Measured on live: 23 of 27 cards named files or lines, and
no Premove was above 0.55.

1. One option is allowed: a packet holds 1 to 4 options.
2. No code on a triage card: the policy flag `plainWords` makes POST
   /api/cards refuse (400) a packet whose text Nil reads holds a file name, a
   path, a line reference, code, a code or diff block, or a commit hash.
3. "Back to the Premove" keeps its place, disabled with nothing changed, and
   nothing above the options moves on an option switch.
4. The Curator skill: one option is the norm, a second shape only for a real
   fork; everything in a member's words; short Issue, Proposal, scope and
   Evidence.
5. The consult skill and the criteria: a one-option card; `against` names a
   shape as the card shows it, or says it in full words; `why` and `against`
   in a member's words.

## 19. The loop-kind card (Nil, 2026-10-30 00:46 CET, relayed by Antifeed PM)

Isomux PM's finding: the Loop app's triage card got 553 calls in 10 days, a
median of 26 s each, with about 60 words and one fixed answer set; Antifeed's
cards got 0 of 35, with 235 to 350 words and options nobody could predict.
Nil: "yeah"; "idk if antifeed pm will fuck up and regress though, so i wonder
if this refactor should be under a toggle in case it makes it worse".

- The switch: `cardKind: "loop"` on a policy (CARD_KIND in
  projects/isomux/triage.ts, isomux triage only). Take the line out and
  restart for the card kind of section 18; the log and the decisions stay
  valid both ways.
- The packet is the Curator's pick: an option named in `recommended` (one
  option; a refine gives variants of it). Plain words (section 18) hold.
- The card is open to Nil as soon as its packet comes. The consult predicts
  as before; its call is the Premove the outcome counts against, and the
  open card does not show it. The outcome compares choice (changed) and
  priority (edited) only: title and scope ride with the pick.
- A call before the Premove is "unpredicted". The predict keeps running, and
  its answer is logged on the card (card.predicted with late and
  afterDecide), not as the Premove; after an Undo it is the Premove for the
  next call. A stored outcome never changes. Such late answers can be scored
  later (an event such as card.scored); not now.
- A rewrite or refine closes the card's predicts; the new packet gets its own.
- The page: the Loop app's card (head line, filed line, title, Why, Proposed
  scope, folds for the current description and the evidence, Choice and
  Priority chips with the pick marked, a note, Confirm), its keys (g d h b o
  w, 0 to 3, Ctrl+Enter), and the queue's rows show the pick, not the Premove.
- Word caps (Antifeed PM, 2026-10-30): the first loop packets had 128 to 176
  words above the folds. The bound is 80 words above the folds: the page's
  own 35 or so, plus a why of at most 40 words, and no scope. The Curator
  skill writes a why of at most 40 words, and a title or scope only when the
  task's own text would send a worker the wrong way (a scope at most 60
  words). The app refuses with a 400 a why over 60 words (every text above
  the folds) or an option's scope over 100 words.
- An author's post with no command for a subject where it has an open card
  is that card's new packet version, not a second card. The author withdraws
  its open card with POST /api/cards/:id/withdraw {actor, reason}.

## 20. Sign-off in Antifeed (Part J; Nil, 2026-10-30: "can we move sign off packets to anti-feed?")

Push stays in the Loop app. Each merged item that waits on the Loop app's
Sign-off list gets a loop-kind card. Isomux Sign-off Scout writes the packet;
its pick (Approve or Revert, with its confidence) is the Premove; Nil decides.

- The switch: SIGNOFF_IN_ANTIFEED in projects/isomux/signoff.ts. Off: no
  source, no policy, no cards, no writes. The Loop app's own tab works
  either way.
- Off after on (B4, Antifeed Reviewer): the log keeps the sign-off events.
  The cards and commands of a policy that is not loaded are off, not gone:
  the view, the queue, /api/status and the dispatcher leave them out, the
  clock does not run them (a wake waits), and decide, Undo, a chat, a start
  or a packet on them is 409 "this policy is off". Nothing is withdrawn or
  cancelled at load. On again, all of it is back; the source withdraws what
  Nil decided on the Loop app's tab meanwhile.
- The one write rule: Antifeed writes to the Loop app only for sign-off, a
  kind Nil moved to it, and only on his call. It presses the Loop app's own
  buttons as its page does: /comments (always, with empty maps when he has
  none, so stored comments never go out unasked), then /approve (no body, or
  {note}) or /reject {note}; an Undo of a pressed call presses /undo. The
  Loop app files the changes task, holds and sends the revert, and computes
  the push point itself. The live Loop app is never edited.
- Source (src/loop-signoff.ts): reads GET /api/signoff every 15 s; a waiting
  item is signoff.item.waiting (its copy, summary, commit, and its images
  copied into blobs); leaving waiting is signoff.item.left; a push go of an
  approved item is signoff.item.pushgo. Read only.
- A call goes to the merge its packet showed (meta.commit); after a re-merge
  it is not sent and a new card shows the item. A decision on the Loop app's
  tab withdraws an open card, or cancels a call not sent yet (F1).
- A 4xx from the Loop app is a failed card with its words; a 5xx or no answer
  "may have gone" (F2), except its 502 "not approved yet".
- Undo: inside Antifeed's 24 s hold it cancels the press; after it, it
  presses /undo; it is refused 20 s before the Loop app sends a revert, and
  after a push go took an approval.
- The page: section 19's card with Approve and Revert (keys a and r), the
  Scout's reason under the title when its verdict is not stamp, "n suggested
  comments", the image pair, and below Confirm the folds with a comment field
  per string and screenshot (LOOP-APP-FEEDBACK.md, Sign-off).
- The end-to-end (2026-10-30, Antifeed Builder): an Antifeed walkthrough copy
  (ANTIFEED_LOOP_URL) against a Loop app copy made from a copy of its code
  and data dir, its office pointed at the copy's fake office, never the live
  ones. tools/signoff-e2e.ts: a waiting item makes a card with its images;
  stamp approves on the copy and files nothing; push back (Approve with a
  note) files the changes task with the note and comment; revert rejects and,
  after the copy's 60 s hold, Isomux Main gets "/isomux-main revert <taskId>
  (<commit>): Nil rejected it at sign-off: <note>"; Undo inside the hold is
  taken and no revert goes; a decision on the copy's tab withdraws the card;
  no failed command, no replay difference. All pass.
  tools/signoff-page-checks.ts on the same copies with 11 live items: all
  pass (lowest Confirm 946 px of 1000 on a desk, 773 px of 844 on a phone).

## 21. Wall Game video review (Nil, 2026-10-30: "i want the video reviews for wall game to show up here as a new kind")

- Accepted design (Antifeed Reviewer and Antifeed PM, 2026-10-30): Antifeed
  calls the game-video app's port (127.0.0.1:21006) directly, with Nil's
  member headers (X-Isomux-Member-Id and X-Isomux-Member-Name). This is the
  path that review.mjs names as its limit ("a process on this box can call the
  app's port directly and set the header"). Antifeed takes it on Nil's own ask
  (2026-10-30), and it presses the app's routes only on Nil's confirmed call,
  after the call's hold: never on a predicted, default or stand-in call.
- Wall Game PM's conditions (2026-10-30): the hashes of what Nil saw go with
  the call, and the queue is read again right before the press (a changed or
  gone video: nothing is pressed); the app gets Nil's note, then a line
  "(via Antifeed)"; a non-2xx is shown in the app's words, with no retry.
- No safe default (`noDefault`, with the safe default rule above): only Wall Game
  Consult's Premove fills in a call.
- Code: projects/wallgame/video.ts, src/game-video.ts, test/video.test.ts.

## 22. Isomux decisions move to the Isomux Inbox (Nil, 2026-10-31, through Isomux PM and Antifeed PM)

Nil's decision: Isomux decision work moves off Antifeed and the loop app into
the Isomux Inbox, as asks. The Isomux crew (Curator, Consult, Sign-off Scout,
Main, workers) opens the asks and acts on Nil's replies. Wall Game stays on
Antifeed. For asks and pages: "no api token to be able to answer asks in the
anti feed". The loop app wakes Isomux Curator for new tasks (its minute
check, live 2026-10-31 03:31 CET), so Antifeed does not read the isomux board.

- Off (src/config.ts): the isomux project (`TRIAGE = false`: its board,
  triage and sign-off; also `SIGNOFF_IN_ANTIFEED = false`) and the Inbox
  project (`INBOX = false`: asks and pages). Nil's API token is not used; the
  start line says so. The loop app seed (triage precedent) runs only while
  triage is on.
- At each start, every waiting card (preparing, predicting or open) of
  triage, signoff, ask and page, and every open failed-command card about
  their commands, is withdrawn by code:engine with the reason "Moved to the
  Isomux Inbox (Nil, 2026-10-31)." (`engine.withdrawOff`, `MOVED_TO_INBOX`).
  Their open predicts close with them. Decided cards keep their calls. The log
  keeps everything (B4: the kinds are off, not gone). `GET
  /api/cards?state=all` lists the cards of a kind that is off, to read only,
  and `GET /api/blobs/:name` serves their images: the Scout and the Curator
  read them for their one-off migration.
- Wall Game video review is off too (Nil, 2026-10-31: "tell wall game
  director to move the approval feed to asks"): `VIDEO_IN_ANTIFEED = false`,
  and "wallgame-video" is in `MOVED_TO_INBOX`; Wall Game Director opens one
  ask per video in Nil's Inbox.
- Wall Game triage is off last (Nil, 2026-10-31: Antifeed winds down;
  `WALLGAME = false`, "wallgame-triage" in `MOVED_TO_INBOX`): Wall Game PM
  opens its triage as asks. No project is loaded; the log, the decision log
  and the blobs are kept (archive/, gitignored), and the app is stopped. The page's Policies, Sources and Help say what moved.
- The Isomux crew's skills are Antifeed PM's; their installed texts are kept
  in projects/isomux/ (*-skill-draft.md). antifeed-consult is Wall Game
  Consult's skill only.
