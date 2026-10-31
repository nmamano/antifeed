// The dispatcher (DESIGN.md section 4): live work after the replay. It sends
// each issued command to its actor under the command type's delivery rule,
// in one office message per actor per burst.

import { ACTION_UNDO_MS, type CommandRec, type Engine, EngineError, PREDICT } from "./engine";
import type { Office } from "./office";
import { Blocked, MaybeSent, type RunContext } from "./policies";
import type { CardMeta, Packet } from "./types";

// At start, a command issued longer ago than its burst plus this is not sent:
// it becomes a command-failed card (a restored backup, a copied data dir).
export const STALE_EXTRA_MS = 10 * 60_000;
// Round 9 (Isomux PM, 2026-10-25): a command that Nil's call caused waits for
// the call's Undo time before it goes out, as an action's Done does, so an
// Undo in that time cancels it and the page's "Undo (24 s)" is true.
export const CALL_HOLD_MS = ACTION_UNDO_MS;

class NoAgent extends Error {}

export type DispatchReport = { sent: { actor: string; commands: string[] }[]; stale: string[]; errors: string[] };

export class Dispatcher {
  private started = false;
  private agentIds = new Map<string, string>();
  private wake: ReturnType<typeof setTimeout> | null = null;
  // The ids of the card.decided events, read from the log once each (the
  // log only grows), so a tick does not scan the whole log.
  private calls = new Set<string>();
  private scanned = 0;
  private scannedLog: readonly unknown[] | null = null;

  constructor(
    private engine: Engine,
    private office: Office,
    private api: string,
    private now: () => number = Date.now,
  ) {}

  // Commands waiting to go: issued, to an agent or code actor, of a policy that is on (Part J, B4).
  private pending(): CommandRec[] {
    return [...this.engine.commands.values()].filter((k) => k.state === "issued" && this.engine.actorFor(k)?.kind !== "human" && this.engine.commandOn(k));
  }

  private fromCall(k: CommandRec): boolean {
    const all = this.engine.log.all();
    if (all !== this.scannedLog || all.length < this.scanned) {
      this.calls.clear();
      this.scanned = 0;
      this.scannedLog = all;
    }
    for (; this.scanned < all.length; this.scanned++) if (all[this.scanned].type === "card.decided") this.calls.add(all[this.scanned].id);
    return this.calls.has(k.causedBy);
  }

  // When each held command goes out: the commands of Nil's calls that wait
  // for the call's Undo time (Status shows it).
  heldUntil(): Record<string, string> {
    const out: Record<string, string> = {};
    const now = this.now();
    for (const k of this.pending()) {
      const until = Date.parse(k.issuedAt) + CALL_HOLD_MS;
      if (this.fromCall(k) && until > now) out[k.id] = new Date(until).toISOString();
    }
    return out;
  }

  private running: Promise<DispatchReport> | null = null;
  private again = false;

  // A new command: send it now, not at the next timer tick. One tick at a
  // time; a kick during a tick runs one more after it.
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.tick().catch((err) => console.error(`dispatch: ${(err as Error).message}`));
  }

  async tick(): Promise<DispatchReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.tickOnce();
    try {
      return await this.running;
    } finally {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  private async tickOnce(): Promise<DispatchReport> {
    const out: DispatchReport = { sent: [], stale: [], errors: [] };
    const now = this.now();
    if (!this.started) {
      this.started = true;
      for (const k of this.pending()) {
        if (now - Date.parse(k.issuedAt) > (k.burstMs ?? 0) + STALE_EXTRA_MS) {
          this.engine.dispatchFailed(k.id, `stale after restart: issued ${k.issuedAt}, not sent; send it again or drop it`);
          out.stale.push(k.id);
        }
      }
      // A batch run that the app's stop cut off: its send may have gone out,
      // so it is never sent again. Its commands fail together (one card).
      const cut = [...this.engine.commands.values()].filter((k) => k.state === "started" && k.batch && this.engine.actorFor(k)?.kind === "code" && this.engine.commandOn(k));
      for (const k of cut) {
        const them = k.batch!.length > 1 ? "them" : "it";
        this.engine.commandResult(k.id, { ok: false, error: `Antifeed stopped during the send; check with ${k.about?.to ?? "the agent"} before you send ${them} again`, detail: "the app stopped while the batch run was started", maybeSent: true });
        out.stale.push(k.id);
      }
    }
    // A command is due when its type's burst is quiet: no newer command of
    // the same type to the same actor for burstMs.
    const pending = this.pending();
    const newest = new Map<string, number>();
    for (const k of pending) {
      const g = `${k.project}|${k.actor}|${k.type}`;
      newest.set(g, Math.max(newest.get(g) ?? 0, Date.parse(k.issuedAt)));
    }
    // A command of Nil's call waits out the call's Undo time; a timer sends it then.
    const heldFor = (k: CommandRec) => (this.fromCall(k) ? Date.parse(k.issuedAt) + CALL_HOLD_MS - now : 0);
    const held = pending.map(heldFor).filter((ms) => ms > 0);
    if (held.length && !this.wake) {
      this.wake = setTimeout(() => ((this.wake = null), this.kick()), Math.min(...held) + 50);
      (this.wake as { unref?: () => void }).unref?.();
    }
    const ready = pending.filter((k) => heldFor(k) <= 0 && now - newest.get(`${k.project}|${k.actor}|${k.type}`)! >= (k.burstMs ?? 0));
    // Predicts go to each actor a few at a time (PREDICT_IN_FLIGHT): those whose
    // card waits for its Premove first, then the oldest. The rest wait, issued.
    const places = new Map<string, number>();
    const first = (k: CommandRec) => (k.type === PREDICT && !this.engine.predictWaits(k) ? 1 : 0);
    const due = ready
      .sort((a, b) => first(a) - first(b) || a.issuedAt.localeCompare(b.issuedAt))
      .filter((k) => {
        if (k.type !== PREDICT) return true;
        const g = `${k.project}|${k.actor}`;
        const left = places.get(g) ?? this.engine.predictPlaces(k.project, k.actor);
        places.set(g, left - 1);
        return left > 0;
      });
    const byActor = new Map<string, CommandRec[]>();
    for (const k of due) byActor.set(`${k.project}|${k.actor}`, [...(byActor.get(`${k.project}|${k.actor}`) ?? []), k]);
    for (const ks of byActor.values()) {
      const actor = this.engine.actorFor(ks[0])!;
      if (actor.kind === "code") {
        const batch = this.engine.batchRunner(ks[0].project, actor.handler);
        if (batch) await this.runBatch(ks, batch, out);
        else for (const k of ks) await this.runCode(k, actor.handler, out);
        continue;
      }
      if (actor.kind !== "agent") continue;
      try {
        await this.sendAgent(actor, ks);
        out.sent.push({ actor: actor.agentName, commands: ks.map((k) => k.id) });
      } catch (err) {
        out.errors.push(`${actor.agentName}: ${(err as Error).message}`);
        // A predict to an agent that is not live fails, so its card gets the
        // stand-in now: in the queue it would wait answerMs (go-live burst,
        // 2026-10-26). After another error (the office restarts) it is sent again.
        if (err instanceof NoAgent)
          for (const k of ks) if (k.type === PREDICT && this.engine.commands.get(k.id)?.state === "issued") this.engine.dispatchFailed(k.id, err.message);
      }
    }
    return out;
  }

  private async agentId(name: string): Promise<string> {
    const known = this.agentIds.get(name);
    if (known) return known;
    for (const a of await this.office.agents()) this.agentIds.set(a.name, a.id);
    const id = this.agentIds.get(name);
    if (!id) throw new NoAgent(`no live agent named "${name}"`);
    return id;
  }

  // at-most-once: logged delivered before the send, never sent again.
  // at-least-once: sent, then logged delivered; a crash between sends again,
  // and the actor's start call (409 on a second start) stops a second run.
  private async sendAgent(actor: { agentName: string; skill?: string }, all: CommandRec[]): Promise<void> {
    const name = actor.agentName;
    const target = await this.agentId(name);
    // After the last await: an Undo may have cancelled some. Send only what
    // is still issued, and an at-most-once command only if this call logged
    // its delivery.
    const ks = all.filter((k) => this.engine.commands.get(k.id)?.state === "issued" && (k.delivery !== "at-most-once" || this.engine.delivered(k.id).length > 0));
    if (!ks.length) return;
    // A predict names its card; other commands their subject.
    const lines = ks.map((k) => `${k.id} ${k.type}${k.type === PREDICT && k.card ? ` ${k.card}` : k.subject ? ` ${k.subject}` : ""}`);
    // The office runs a message that starts with "/" as a skill: the actor's
    // own skill loads with the commands. No skill, no slash.
    const head = actor.skill ? `/${actor.skill} Antifeed:` : "Antifeed:";
    const text = [
      `${head} ${ks.length} command${ks.length === 1 ? "" : "s"}. For each: read it (GET ${this.api}/api/commands/<id>), start it (POST .../start; on 409 do not act), act, then report the result. API: curl -s ${this.api}/api/help`,
      ...lines,
    ].join("\n");
    try {
      await this.office.message(text, target);
    } catch (err) {
      // The id may be stale (a killed agent with a new one by the same name).
      this.agentIds.delete(name);
      throw err;
    }
    // A command cancelled during the send is in the message, but its start
    // is refused, so the actor does not act on it.
    for (const k of ks) if (k.delivery === "at-least-once") this.engine.delivered(k.id);
  }

  private ctx(): RunContext {
    return { office: this.office, card: (id) => { const c = this.engine.cards.get(id); return c ? structuredClone(c) : undefined; }, api: this.api };
  }

  // A burst in one run (slice 8): each command is logged delivered and
  // started first, so an Undo after this point is refused, a command
  // cancelled since the tick read it is left out, and a crash during the run
  // sends none of them again. The run's one result sets them all done or all
  // failed.
  private async runBatch(all: CommandRec[], h: (ks: CommandRec[], ctx: RunContext) => Promise<unknown[]>, out: DispatchReport): Promise<void> {
    const ks = all.filter((k) => this.engine.delivered(k.id).length > 0);
    if (!ks.length) return;
    // The ids of the run go with each start: a failure gives one card for all.
    const ids = ks.map((k) => k.id);
    for (const k of ks) this.engine.startCommand(k.id, ids);
    try {
      const data = await h(ks.map((k) => structuredClone(k)), this.ctx());
      ks.forEach((k, i) => this.engine.commandResult(k.id, { ok: true, data: data[i] ?? null }));
    } catch (err) {
      out.errors.push(`${ids.join(", ")}: ${(err as Error).message}`);
      const detail = (err as { detail?: unknown }).detail;
      for (const k of ks) this.engine.commandResult(k.id, { ok: false, error: (err as Error).message, blocked: err instanceof Blocked, maybeSent: err instanceof MaybeSent, ...(typeof detail === "string" ? { detail } : {}) });
    }
  }

  private async runCode(k: CommandRec, handler: string, out: DispatchReport): Promise<void> {
    const h = this.engine.runner(k.project, handler);
    // Cancelled since the tick read it: nothing runs.
    if (!this.engine.delivered(k.id).length) return;
    if (!h) {
      this.engine.dispatchFailed(k.id, `no handler "${handler}"`);
      return;
    }
    try {
      // A predict to a code actor (the walkthrough stub): its result is the
      // prediction, or {skip} to leave it unstarted, or {delayMs} to answer late.
      if (k.type === PREDICT) {
        const r = (await h(structuredClone(k), this.ctx())) as { skip?: boolean; delayMs?: number; prediction?: unknown } | null;
        if (!r || r.skip) return;
        this.engine.startCommand(k.id);
        const answer = () => {
          try {
            this.engine.predictionResult(k.id, r.prediction);
          } catch (err) {
            console.error(`predict ${k.id}: ${(err as Error).message}`);
          }
        };
        if (r.delayMs) setTimeout(answer, r.delayMs);
        else answer();
        return;
      }
      this.engine.startCommand(k.id);
      const data = await h(structuredClone(k), this.ctx());
      // A code author (the walkthrough's demo author, round Q1): {packet, meta}
      // answers its policy's prepare command with the card's next packet
      // version, as an agent's POST /api/packets with the command id does. A
      // card decided or withdrawn meanwhile takes no packet: the prepare is
      // done, skipped (DESIGN.md section 3), and no failure card is opened.
      const prepare = this.engine.policies().find((x) => x.policy.id === k.policy)?.policy.prepare;
      if (k.type === prepare && k.card && data && typeof data === "object" && "packet" in data) {
        const d = data as { packet: Packet; meta: Partial<CardMeta> & { raw: string } };
        try {
          this.engine.postPacket({ command: k.id, packet: d.packet, meta: d.meta });
        } catch (err) {
          if (!(err instanceof EngineError && err.status === 409)) throw err;
          this.engine.commandResult(k.id, { ok: true, data: { skipped: err.message } });
        }
        return;
      }
      this.engine.commandResult(k.id, { ok: true, data: data ?? null });
    } catch (err) {
      out.errors.push(`${k.id}: ${(err as Error).message}`);
      // Part J: a single code command says "may have gone" and keeps its detail too, as a batch does.
      this.engine.commandResult(k.id, { ok: false, error: (err as Error).message, blocked: err instanceof Blocked, maybeSent: err instanceof MaybeSent, detail: (err as { detail?: string }).detail });
    }
  }
}
