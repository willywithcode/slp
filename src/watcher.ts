import type { Deps } from "./core/deps.js";
import { GoneError } from "./core/errors.js";
import { append, readLedger, type SlpEvent } from "./core/ledger.js";
import { loadProject, type Project } from "./core/project.js";
import { pendingRequests, runRequest } from "./land.js";
import { describe, pump, sendLetter } from "./letters.js";
import { closeSeat } from "./seats.js";
import { fold, liveSeats, superiorOf, type Seat, type State } from "./state.js";

// The watcher (ADR 0009): code, not a seat. It relays waiting letters, runs
// gates and landings, and keeps the team moving with a few plain rules.
// Phase 4 adds transcript facts and incidents; Jev (ADR 0013) is optional.

export const watchTiming = {
  /** A seat stuck on a prompt in its pane this long is reported. */
  blockedMs: 3 * 60_000,
  /** An unanswered ask is reminded after this long, then as often again. */
  askReminderMs: 10 * 60_000,
  askReminders: 3,
  /** Ticks a live seat's pane may be missing from Herdr before it counts as gone. */
  goneTicks: 3,
};

export class Watcher {
  private inflight: Promise<void> | null = null;
  private readonly blockedSince = new Map<string, number>();
  private readonly blockedTold = new Set<string>();
  private readonly missing = new Map<string, number>();

  constructor(private readonly deps: Deps, private readonly projectId: string) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** One pass. Throws GoneError when the project no longer exists. */
  async tick(): Promise<void> {
    const project = await loadProject(this.deps.env, this.projectId);
    if (!project) throw new GoneError(`Project ${this.projectId} does not exist`);
    await pump(this.deps, project.id);
    this.startRequest(project, await readLedger(this.deps.env, project.id));
    const state = fold(await readLedger(this.deps.env, project.id));
    const agents = await this.deps.herdr.agentList().catch(() => null);
    if (agents) {
      const status = new Map(agents.map((a) => [a.paneId, a.status]));
      await this.checkPanes(project, state, status);
      await this.retire(project, state, status);
    }
    await this.remindAsks(project, state);
  }

  /** Wait for a gate or landing in progress (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  private startRequest(project: Project, events: SlpEvent[]): void {
    if (this.inflight) return;
    const next = pendingRequests(events)[0];
    if (!next) return;
    this.deps.out(`working on ${next.request}: ${next.what} ${next.lane}`);
    this.inflight = runRequest(this.deps, project, next)
      .catch(async (error: unknown) => {
        this.deps.out(`${next.request} failed: ${describe(error)}`);
        await append(this.deps.env, project.id, () => ({
          kind: "request-done" as const, request: next.request, ok: false, detail: `slp error: ${describe(error)}`,
        })).catch(() => undefined);
        await this.tell(project, fold(events), "sup", `slp could not finish ${next.what} for ${next.lane}: ${describe(error)}`, next.lane);
      })
      .finally(() => { this.inflight = null; });
  }

  private async tell(project: Project, state: State, to: string | null, text: string, lane: string | null): Promise<void> {
    const target = to && state.seats.get(to)?.live ? to : "human";
    await sendLetter(this.deps, project.id, { letter: "NOTICE", from: "slp", to: target, lane, text })
      .catch((error: unknown) => this.deps.out(`could not tell ${target}: ${describe(error)}`));
  }

  /** Seats whose pane is gone, or stuck on a prompt only the Human can answer. */
  private async checkPanes(project: Project, state: State, status: Map<string, string>): Promise<void> {
    for (const seat of liveSeats(state)) {
      const s = status.get(seat.paneId);
      if (s === undefined) {
        const n = (this.missing.get(seat.name) ?? 0) + 1;
        this.missing.set(seat.name, n);
        if (n >= watchTiming.goneTicks) {
          this.missing.delete(seat.name);
          await append(this.deps.env, project.id, () => ({ kind: "seat-stop" as const, name: seat.name, reason: "its pane is gone" }));
          await this.tell(project, state, superiorOf(state, seat),
            `${seat.name} (${seat.role}) is gone: its pane ${seat.paneId} no longer runs an agent.`, seat.lane);
        }
        continue;
      }
      this.missing.delete(seat.name);
      if (s === "blocked") {
        const since = this.blockedSince.get(seat.name) ?? this.now();
        this.blockedSince.set(seat.name, since);
        if (this.now() - since >= watchTiming.blockedMs && !this.blockedTold.has(seat.name)) {
          this.blockedTold.add(seat.name);
          await this.deps.herdr.notify(`slp: ${seat.name} waits on you`, `A prompt in pane ${seat.paneId} needs the Human.`).catch(() => undefined);
          const up = superiorOf(state, seat);
          if (up) {
            await this.tell(project, state, up,
              `${seat.name} has waited on a prompt in its pane for ${Math.round((this.now() - since) / 60_000)} min; the Human was notified.`, seat.lane);
          }
        }
      } else {
        this.blockedSince.delete(seat.name);
        this.blockedTold.delete(seat.name);
      }
    }
  }

  /** Close Reviewer and Critic seats that have reported, once their turn ends. */
  private async retire(project: Project, state: State, status: Map<string, string>): Promise<void> {
    for (const seat of liveSeats(state)) {
      if (!finished(state, seat)) continue;
      const s = status.get(seat.paneId);
      if (s === "working" || s === "blocked") continue;
      await closeSeat(this.deps, project.id, seat, "reported");
      this.deps.out(`closed ${seat.name}: it has reported`);
    }
  }

  private async remindAsks(project: Project, state: State): Promise<void> {
    for (const ask of state.asks.values()) {
      if (ask.answer !== null || ask.to === "human") continue;
      if (!state.seats.get(ask.to)?.live || !state.seats.get(ask.from)?.live) continue;
      const reminders = state.letters.filter((l) => l.letter === "STILL_OPEN" && l.text.startsWith(`${ask.id} `));
      if (reminders.length >= watchTiming.askReminders) continue;
      const last = Date.parse(reminders.at(-1)?.ts ?? ask.askedAt);
      if (this.now() - last < watchTiming.askReminderMs) continue;
      await sendLetter(this.deps, project.id, { letter: "STILL_OPEN", from: "slp", to: ask.to,
        text: `${ask.id} from ${ask.from} is unanswered after ${Math.round((this.now() - Date.parse(ask.askedAt)) / 60_000)} min: ${ask.text}` })
        .catch((error: unknown) => this.deps.out(`could not remind ${ask.to}: ${describe(error)}`));
    }
  }
}

function finished(state: State, seat: Seat): boolean {
  if (seat.role === "reviewer") return [...state.reviews.values()].some((r) => r.seat === seat.name && r.done);
  if (seat.role === "critic") return state.letters.some((l) => l.from === seat.name && l.letter === "CRITIQUE");
  return false;
}
