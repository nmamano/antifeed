// Core types of Antifeed (DESIGN.md sections 2-5).

export type StandinBasis = "vote" | "author" | "none";

// Who does a thing.
export type ActorRef = `agent:${string}` | `code:${string}` | `human:${string}` | "clock";

export type Actor =
  | { id: string; kind: "agent"; agentName: string; skill?: string }
  | { id: string; kind: "code"; handler: string }
  | { id: string; kind: "human"; member: string };

// A past fact. Append-only. `at` is the only clock a reducer may read.
export type Event = {
  seq: number;
  id: string;
  at: string;
  type: string;
  by: ActorRef;
  project?: string;
  subject?: string;
  card?: string;
  command?: string;
  causedBy?: string;
  key?: string;
  batch: string;
  member?: string;
  // The policy whose `out` made this event (derived events only).
  policy?: string;
  data: any;
};

// An event before the log gives it seq, id, at and batch.
export type EventDraft = Omit<Event, "seq" | "id" | "at" | "batch"> & { id?: string; at?: string };

export type Command = {
  id: string;
  type: string;
  policy: string;
  project: string;
  actor: string;
  subject?: string;
  card?: string;
  params: unknown;
  causedBy: string;
};

export type CommandState = "issued" | "delivered" | "started" | "done" | "failed" | "cancelled";

export type Delivery = "at-least-once" | "at-most-once";

// `what`: what the command does, in words, for the page (round 10); the type stays its id.
// `failedWords`: for an action, what "Could not do it" did, for Decided (slice 7: a page stays open).
// notifyDrop: when Nil drops the failed command on its failure card, the
// owner policy gets command.dropped, so it can free what the command held (slice 8).
// when: when the policy sends it, in words ("After your call"); only: for one
// of several commands sent at one time, which call picks it ("if you reply").
// The Policies tab groups the commands by when (round q1b, P3).
export type CommandDecl = { actor: string; delivery: Delivery; burstMs?: number; timeoutMs?: number; what?: string; when?: string; only?: string; failedWords?: string; notifyDrop?: boolean };

// What one command is about, in plain words, for the page: the Status line
// while it waits, and the failed-command card if it fails (slice 7: "Your
// reply to Demo Worker", with the ask and the words as rows).
// Slice 8 walk, a failed-command card in Nil's words only: one and many are
// the head for one command and for n of one send ("Your call to Wall Game
// PM", "Your {n} calls to Wall Game PM"); label and name are the command's
// first row ("Call", the task's title); ids go in the ids fold; to names who
// gets it; noReassign offers only Send again and Drop.
export type CommandAbout = { title: string; rows?: [string, string][]; one?: string; many?: string; label?: string; name?: string; ids?: [string, string][]; to?: string; noReassign?: boolean };

// What a reducer may ask for. The engine turns each item into a logged event.
export type OutItem =
  | { emit: { type: string; subject?: string; data: unknown } }
  // packet: an action for a human (an action card); meta: that card's metadata (slice 7).
  // about: the command in plain words (CommandAbout).
  | { issue: { type: string; subject?: string; card?: string; params: unknown; packet?: Packet; meta?: Partial<CardMeta>; about?: CommandAbout } }
  // A new packet for an action card this policy issued, while Nil has not
  // marked it (slice 7: a page raised again with the same words has a new count).
  | { repacket: { card: string; packet: Packet } }
  | { open: CardDraft }
  // reason: why the card left the queue, in words, for the Decided tab (slice 7).
  | { withdraw: string; reason?: string }
  // reason: why, in words, for the Decided tab (slice 7: "not sent: the ask was closed in the office first").
  | { cancel: string; reason?: string }
  | { wakeAt: string }
  // Built-in command-failed policy only: issue a failed command again.
  | { reissue: { command: string; actor?: string } }
  // The built-in policy only: Nil dropped this failed command (CommandDecl.notifyDrop).
  | { dropped: { command: string } };

export type Reaction<S> = { state: S; out?: OutItem[] };

// A card a policy opens. `prepare` issues the author's command for its packet
// in the same batch, linked to the new card.
export type CardDraft = {
  subject?: string;
  meta?: Partial<CardMeta>;
  prepare?: { type: string; params: unknown };
  // The policy is the author: the packet is in the same batch.
  packet?: Packet;
};

export type Policy<S = any> = {
  id: string;
  // The kind's plain name on the page ("Triage"), and its color (#rrggbb).
  name?: string;
  color?: string;
  on: string[];
  emits: string[];
  final?: string[];
  commands: Record<string, CommandDecl>;
  decider?: DeciderConfig;
  autoAllowed?: boolean;
  answer?: AnswerSchema;
  primary?: string[];
  author?: string | string[];
  // The command that asks the author for a packet. The engine issues it
  // itself for rewrite and refine; a policy without one takes neither.
  prepare?: string;
  // A check of a call beyond the schema (for example: go needs a priority).
  // packet: the card's packet as Nil saw it (a video whose Approve cannot be taken).
  validate?: (call: Call, packet?: Packet | null) => string | null;
  // The safe default call: the last stand-in, when nothing gives a basis
  // for a Premove (DESIGN.md 13.7). Required for a policy with a decider,
  // unless it has noDefault.
  fallback?: Call;
  // No safe default (Wall Game video: Approve posts a video publicly; Antifeed
  // PM, 2026-10-30): the words why, on the card. Only the Predictor's
  // Premove fills in a call: a stand-in has no basis (no quick model run, no
  // vote) and fills in nothing. Such a policy names no fallback.
  noDefault?: string;
  // Values made from a call and its packet, never sent: a `primary` field may
  // name one, and the outcome compares it (slice 7: an ask's choice is the
  // option its text came from, or "own words").
  derived?: Record<string, (call: Call, packet: Packet | null) => string | null>;
  // Undo of a decided card is refused once a command of the call went out,
  // with these words (slice 7: a reply cannot be taken back).
  undoUntilSent?: string;
  // Slice 8 walk: code makes the packet, so no author agent reads the note
  // or names a pick. notePlaceholder: who reads Nil's note instead.
  noAuthor?: boolean;
  notePlaceholder?: string;
  // The word before the card's subject on the page ("Task"); null hides it
  // (slice 7: an ask's id means nothing to Nil).
  subjectLabel?: string | null;
  // The call has no note field on the page (slice 7: an ask's words go in its reply).
  noNote?: boolean;
  // Nil reads no code on its cards (Nil, 2026-10-29): POST /api/cards refuses
  // a packet whose text holds a file name, a line, a code span or a hash.
  plainWords?: boolean | "above-folds";
  // Part J (sign-off): "above-folds" checks the question, the blocks above
  // the folds and the options, not the folds (the folds hold file paths by design).
  // "loop": the Loop app's triage card (Nil, 2026-10-30: "this refactor
  // should be under a toggle"). A packet of one option, the packet creator's
  // pick; the card is open as soon as its packet comes, while the Predictor
  // still predicts; the page shows the pick, not the Premove. Absent: the
  // card kind every other policy has.
  cardKind?: "loop";
  // A loop-kind card's outcome compares these fields of the call (default:
  // triage's choice and priority; sign-off's call).
  loopCompare?: string[];
  // Part J: a check of an agent's packet beyond the plain words (the
  // author's pick, its meta), at POST /api/cards; an error is a 400.
  checkPacket?: (packet: Packet, meta: Record<string, unknown>) => string | null;
  // Part J: Undo of a decided card is refused with these words, when the
  // outside write of the call can no longer be taken back.
  undoRefusal?: (state: S, card: Card, now: number) => string | null;
  // The subject as its source has it now (a board task: title, priority,
  // description, when it was filed), for the page.
  subjectInfo?: (state: any, subject: string) => SubjectInfo | null;
  // What the safe default does, in words, on its button and in Settings
  // (slice 7: an ask's filed task closes the ask).
  fallbackHelp?: string;
  // The chip of this policy's action cards, for "Action for you" (slice 7:
  // "Page for you", so a page from the office is not like any action).
  actionLabel?: string;
  // The word before the card's filer in its head ("From"), with the tip
  // "Who sent it"; by default "Filed by" (a board task). Slice 7 walk.
  createdByLabel?: string;
  // The calls whose command went out, and when Antifeed saw each land
  // (slice 8: a Wall Game call is on the board once its call line is).
  landing?: (state: S) => Landing[];
  init: S;
  reduce(state: S, e: Event): Reaction<S>;
};

// One sent call, for Status: to whom, when, and when its effect showed.
export type Landing = { card: string; subject: string; title: string; call: string; to: string; sentAt: string; landedAt: string | null };

export type Call = { [field: string]: string | null | undefined; note?: string };

// rewrite: the author makes a new packet as the note asks. refine: "closer to
// this one", the author returns variants of one option.
export type Generic = { kind: "rewrite" } | { kind: "refine"; option: string };

export type Prediction = {
  call: Call;
  confidence: number;
  why: string;
  against: string;
  by: ActorRef;
  precedent: string[];
  // A consult agent's Premove: how many past calls its input named by their
  // route, for it to read (Nil, 2026-10-29); precedent is then empty.
  pastCalls?: number;
  // What the run cost, when the decider knows it.
  usd?: number;
  // The consult agent's prediction carries Nil's own view (DESIGN.md 13.1):
  // kept out of calibration.
  informed?: boolean;
  // A stand-in: the consult agent did not answer in time, or failed.
  // basis: the code stand-in's tier, as data (vote, the author's pick, none).
  standin?: { reason: string; predictorError?: string; basis?: StandinBasis };
  // Blob names: the exact input Antifeed sent, and the raw answer.
  input?: string;
  answer?: string;
};

export type DeciderStep =
  // A decider decides with its prediction: the engine uses prediction.call,
  // .confidence and .by, after the same check as a Premove.
  | { kind: "decided"; prediction: Prediction }
  | { kind: "ask"; prediction: Prediction | null };

export type DeciderConfig =
  | { kind: "code"; handler: string }
  | { kind: "agent"; model: string; criteria: string }
  | { kind: "nil"; predictor?: DeciderConfig }
  // The project's consult agent predicts, through a predict command (DESIGN.md 13.1).
  | { kind: "consult"; criteria: string }
  | { kind: "threshold"; agent: DeciderConfig; min: number };

export type CardMeta = {
  source: string;
  author: ActorRef | null;
  openedAt: string;
  raw: string;
  priority?: string;
  effort?: string;
  createdBy?: string;
  // Part J: the Sign-off Scout's verdict on its pick, its confidence and the comments it suggests.
  scout?: { verdict: "stamp" | "look" | "pushback"; confidence: number; suggestions: { copy: Record<string, string>; images: Record<string, string> } };
};

export type SubjectInfo = { title: string; priority: string | null; description: string; createdAt: number | null; signoff?: SignoffInfo };
// Part J: a sign-off item as the Loop app has it, for the page's folds and comment fields.
export type SignoffCopy = { where: string; old: string; new: string; audience: "member" | "agent" };
export type SignoffImage = { blob: string; caption: string; pair?: string; side?: "before" | "after" };
export type SignoffInfo = { taskId: string; commit: string; mergedAt: number | null; summary: string; copy: SignoffCopy[]; images: SignoffImage[]; loopState: string };

export type CardState = "preparing" | "predicting" | "open" | "decided" | "done" | "withdrawn";

export type Card = {
  id: string;
  kind: "decision" | "action";
  policy: string;
  project: string;
  subject?: string;
  version: number;
  state: CardState;
  packet: Packet | null;
  prediction: Prediction | null;
  // The predictor ran (or failed) for this version.
  predicted: boolean;
  // The versions whose Premove Nil could see (card.shown).
  shown: number[];
  // A loop-kind card's answer that came after Nil's call (lateAfterDecide):
  // logged, and the Premove for his next call after an Undo.
  lateAfterDecide?: boolean;
  // The consult agent's answer that came after Nil saw a stand-in: shown, not the Premove.
  latePrediction?: Prediction;
  meta: CardMeta;
  command?: string;
  // option: the packet option Nil's call came from, if any.
  decision?: { event: string; call: Call; by: ActorRef; generic?: Generic; option?: string };
  changedAfterPacket?: boolean;
  // A rewrite or refine brought no new packet: the reason, until the next packet or call.
  reopened?: string;
  // An action's Done or Could not do it that waits for its Undo time.
  held?: { event: string; ok: boolean; note: string; until: string; member: string };
};

export type Packet = {
  question: string;
  blocks: Block[];
  options?: Option[];
  recommended?: string;
  // Slice 8 walk: fewer values of an enum field on this card, or null to
  // leave the field out; a call outside the limit is refused.
  limit?: Record<string, (string | null)[] | null>;
};

export type Block =
  // tone "warn": a line the page shows in the warning color (a video's sound with a high claim risk).
  | { type: "markdown"; text: string; tone?: "warn" }
  | { type: "diff"; unified: string; path?: string }
  // focus: the part that needs Nil's attention, as fractions of the image's width and height (round 9).
  // wide: at the card's full width (slice 7 walk: a dense screenshot in an ask).
  | { type: "image"; blob: string; caption?: string; pair?: { name: string; side: "before" | "after" }; focus?: { x: number; y: number; w: number; h: number }; wide?: boolean }
  | { type: "video"; blob: string; caption?: string }
  | { type: "link"; url: string; label: string }
  | { type: "demo"; url: string }
  | { type: "chart"; spec: unknown }
  | { type: "draft"; key: string; text: string }
  | { type: "checklist"; items: string[] }
  | { type: "fields"; rows: [string, string][] }
  // Slice 7: a command to copy (an ask's terminal commands), and a file to open or download.
  | { type: "code"; text: string }
  | { type: "file"; blob: string; name: string; size?: number }
  | { type: "fold"; title: string; blocks: Block[] };

export type Option = { id: string; label: string; cost?: string; fill: Call; blocks?: Block[] };

export type AnswerField = {
  enum?: (string | null)[];
  text?: { max: number };
  // The page's label and a line of help (DESIGN.md 13.7).
  label?: string;
  help?: string;
  // "option": a one-line call text shows the label of the option that fills
  // this text, or "own <label>", not the text (triage's scope, 2026-10-29).
  inLine?: "option";
  // Rules the page can check before a send, and the engine checks again:
  // this field must have a value when another field has one of these values,
  // and must be null when another field has one of those.
  needs?: Record<string, (string | null)[]>;
  noneWith?: Record<string, (string | null)[]>;
};
export type AnswerSchema = Record<string, AnswerField>;

export type Outcome = "matched" | "edited" | "changed" | "unpredicted";

export type DecisionLine = {
  id: string;
  at: string;
  policy: string;
  project: string;
  card: string;
  version: number;
  subject?: string;
  snapshot: { question: string; blocks: Block[]; options: Option[]; recommended: string | null; meta: CardMeta };
  prediction: Prediction | null;
  call: Call;
  generic?: Generic;
  by: ActorRef;
  // null for a call an agent or code made: it has no human outcome.
  outcome: Outcome | null;
  note: string;
  shownAt: string | null;
  secondsToDecide: number | null;
  imported?: boolean;
};

export type UndoLine = { id: string; at: string; undoes: string };
