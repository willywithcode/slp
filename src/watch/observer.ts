import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, type Config } from "../core/config.js";
import type { Deps } from "../core/deps.js";
import type { Project } from "../core/project.js";
import { ROLE_SPECS } from "../roles.js";
import { leadOf, liveSeats, type Seat, type State } from "../state.js";
import { screenFact, stepFacts, stuckFact, unverifiedFact, type Fact } from "./facts.js";
import { raise } from "./incidents.js";
import { claudeSteps, codexSteps, findClaudeTranscript, findCodexRollout, TranscriptTail, type Step } from "./transcripts.js";

// Reads every seat's transcript as it grows and turns what it finds into
// incidents (ADR 0009). Workers (Leads, Peers) are watched for their work;
// every seat is watched for account problems.

export const observeTiming = {
  /** How often a missing transcript is looked for again. */
  lookupMs: 30_000,
  /** How often idle seats' screens are checked for account messages. */
  screenMs: 30_000,
  /** A turn working longer than this is noted to the seat's superior. */
  longTurnMs: 20 * 60_000,
  /** Steps kept per seat for window facts (stuck, unverified). */
  window: 400,
};

interface Watched {
  key: string;
  tail: TranscriptTail | null;
  lookedAt: number;
  steps: Step[];
  screenAt: number;
  workingSince: number | null;
}

const ACCOUNT = new Set(["usage_limit", "auth_failed"]);

/** Where the watch hands moments to Jev's decision points (they run their own fallbacks). */
export interface ObserverHooks {
  turnEnded?(project: Project, state: State, config: Config, seat: Seat, steps: readonly Step[]): Promise<void>;
  unknownError?(project: Project, state: State, config: Config, seat: Seat, step: Step): Promise<void>;
}

export class Observer {
  private readonly seats = new Map<string, Watched>();
  /** task-done events already checked for unverified claims. */
  private readonly checkedDone = new Set<string>();

  constructor(private readonly deps: Deps, private readonly hooks: ObserverHooks = {}) {}

  /** The steps seen so far for a seat (for Jev's state). */
  steps(seat: string): readonly Step[] {
    return this.seats.get(seat)?.steps ?? [];
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  async observe(project: Project, state: State, config: Config, status: Map<string, string>): Promise<void> {
    const live = liveSeats(state);
    for (const name of [...this.seats.keys()]) if (!live.some((s) => s.name === name)) this.seats.delete(name);
    for (const seat of live) {
      const w = await this.watched(seat, config);
      const fresh = w.tail ? await w.tail.next().catch(() => []) : [];
      if (fresh.length) w.steps = [...w.steps, ...fresh].slice(-observeTiming.window);
      const facts: Fact[] = [];
      const worker = ROLE_SPECS[seat.role].watched;
      const found = stepFacts(fresh, this.context(state, seat));
      facts.push(...found.filter((f) => worker || ACCOUNT.has(f.fact)).map((f) => (seat.role === "lead" ? leadWrote(f) : f)));
      for (const step of fresh) {
        if (step.kind === "error" && !found.some((f) => ACCOUNT.has(f.fact) && f.key.endsWith(step.at))) {
          await this.hooks.unknownError?.(project, state, config, seat, step);
        }
      }
      if (worker) {
        const stuck = stuckFact(w.steps);
        if (stuck) facts.push(stuck);
      }
      const s = status.get(seat.paneId);
      if (s === "working") {
        w.workingSince ??= this.now();
        if (this.now() - w.workingSince > observeTiming.longTurnMs && worker) {
          facts.push({ fact: "long_turn", level: "note", key: `long_turn:${w.workingSince}`,
            text: `has been working on one turn for ${Math.round((this.now() - w.workingSince) / 60_000)} min` });
        }
      } else {
        if (w.workingSince !== null && worker) await this.hooks.turnEnded?.(project, state, config, seat, w.steps);
        w.workingSince = null;
        if ((s === "idle" || s === "done") && this.now() - w.screenAt >= observeTiming.screenMs) {
          w.screenAt = this.now();
          const screen = await this.deps.herdr.agentRead(seat.paneId).catch(() => "");
          const f = screenFact(screen);
          if (f) facts.push(f);
        }
      }
      for (const f of facts) await raise(this.deps, project.id, state, config, seat, f);
    }
    await this.ledgerShapes(project, state, config);
  }

  private context(state: State, seat: Seat): { owned: readonly string[] | null; workdir: string } {
    const task = seat.task ? state.tasks.get(seat.task) : undefined;
    const lane = seat.lane ? state.lanes.get(seat.lane) : undefined;
    if (seat.role === "peer" && task) return { owned: task.owned, workdir: task.workdir };
    // A Lead writes no code at all: any edit in its copy is outside what it owns.
    if (seat.role === "lead" && lane) return { owned: [], workdir: lane.workdir };
    return { owned: null, workdir: lane?.workdir ?? "" };
  }

  private async watched(seat: Seat, config: Config): Promise<Watched> {
    const key = `${seat.paneId}:${seat.openedAt}`;
    let w = this.seats.get(seat.name);
    if (!w || w.key !== key) {
      w = { key, tail: null, lookedAt: 0, steps: [], screenAt: 0, workingSince: null };
      this.seats.set(seat.name, w);
    }
    if (!w.tail && this.now() - w.lookedAt >= observeTiming.lookupMs) {
      w.lookedAt = this.now();
      const path = await this.find(seat, config).catch(() => null);
      if (path) w.tail = new TranscriptTail(path, seat.agent === "codex" ? codexSteps : claudeSteps);
    }
    return w;
  }

  private async find(seat: Seat, config: Config): Promise<string | null> {
    if (seat.agent === "claude" && seat.sessionId) return findClaudeTranscript(this.deps.env, seat.sessionId);
    if (seat.agent === "codex" && seat.marker) {
      // Its own home first; a seat moved to another account may still write where it began.
      return findCodexRollout(codexHomes(config, this.deps.env, seat.launcher), seat.marker, new Date(seat.openedAt));
    }
    return null;
  }

  /** Facts about the record itself: hand-backs, reworks, reviews, briefs. */
  private async ledgerShapes(project: Project, state: State, config: Config): Promise<void> {
    for (const task of state.tasks.values()) {
      const lead = leadOf(state, task.lane);
      const peer = state.seats.get(task.seat);
      const done = task.lastDone;
      if (done && done.outcome === "complete" && !this.checkedDone.has(`${done.seq}`)) {
        this.checkedDone.add(`${done.seq}`);
        const steps = peer ? this.seats.get(peer.name)?.steps : undefined;
        const f = steps?.length ? unverifiedFact(steps, task.id) : null;
        if (f && peer) await raise(this.deps, project.id, state, config, peer, f);
      }
      if (!lead) continue;
      const facts: Fact[] = [];
      if (task.reworks >= 3) {
        facts.push({ fact: "rework_loop", level: "attend", key: `rework_loop:${task.id}`, text: `sent ${task.id} back ${task.reworks} times` });
      }
      if (task.state === "accepted" && done && done.outcome !== "complete") {
        facts.push({ fact: "accepted_unfinished", level: "note", key: `accepted_unfinished:${task.id}`, text: `accepted ${task.id}, which was handed back as ${done.outcome}` });
      }
      if (/```|^\s*\d+\.\s+(edit|change|replace|add|insert|in)\b.*(line|file|function)/im.test(`${task.goal}\n${task.context}`)) {
        facts.push({ fact: "brief_prescribes", level: "note", key: `brief_prescribes:${task.id}`, text: `briefed ${task.id} with code or edit steps rather than an outcome` });
      }
      for (const f of facts) await raise(this.deps, project.id, state, config, lead, f);
    }
    for (const lane of state.lanes.values()) {
      if (!lane.open) continue;
      const lead = leadOf(state, lane.id);
      if (!lead) continue;
      const rounds = [...state.reviews.values()].filter((r) => r.lane === lane.id && r.done?.findings.some((x) => x.severity === "high"));
      if (rounds.length >= 3) {
        await raise(this.deps, project.id, state, config, lead,
          { fact: "reviews_not_converging", level: "attend", key: `reviews_not_converging:${lane.id}`, text: `has had ${rounds.length} reviews with high findings in ${lane.id}` });
      }
    }
  }
}

/** Codex homes to search: the launcher's own first, then every other one configured. */
export function codexHomes(config: Config, env: Deps["env"], first?: string): string[] {
  const fallback = env.CODEX_HOME || join(homedir(), ".codex");
  const homeOf = (name: string) => {
    const own = config.launchers[name]?.env.CODEX_HOME;
    return own ? expandHome(own) : fallback;
  };
  const names = Object.keys(config.launchers).filter((n) => config.launchers[n]!.agent === "codex");
  return [...new Set([...(first ? [homeOf(first)] : []), ...names.map(homeOf), fallback])];
}

function leadWrote(f: Fact): Fact {
  return f.fact === "outside_owned" ? { ...f, fact: "lead_wrote", text: f.text.replace(/^edited outside its owned paths \(\): /, "wrote files itself (Leads brief Peers): ") } : f;
}
