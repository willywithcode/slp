import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../core/config.js";
import { ROLE_SPECS } from "../roles.js";
import { leadOf, liveSeats } from "../state.js";
import { screenFact, stepFacts, stuckFact, unverifiedFact } from "./facts.js";
import { raise } from "./incidents.js";
import { claudeSteps, codexSteps, findClaudeTranscript, findCodexRollout, TranscriptTail } from "./transcripts.js";
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
    /** An edit whose result never shows up counts as made after this long. */
    editResultMs: 60_000,
    /** A hand-back is checked without its transcript once it is this old. */
    handbackWaitMs: 10 * 60_000,
};
const ACCOUNT = new Set(["usage_limit", "auth_failed"]);
export class Observer {
    deps;
    hooks;
    seats = new Map();
    /** task-done events already checked for unverified claims. */
    checkedDone = new Set();
    constructor(deps, hooks = {}) {
        this.deps = deps;
        this.hooks = hooks;
    }
    /** The steps seen so far for a seat (for Jev's state). */
    steps(seat) {
        return this.seats.get(seat)?.steps ?? [];
    }
    now() { return this.deps.now?.() ?? Date.now(); }
    async observe(project, state, config, status) {
        const live = liveSeats(state);
        for (const name of [...this.seats.keys()])
            if (!live.some((s) => s.name === name))
                this.seats.delete(name);
        for (const seat of live) {
            const w = await this.watched(seat, config);
            const fresh = w.tail ? await w.tail.next().catch(() => []) : [];
            if (fresh.length)
                w.steps = [...w.steps, ...fresh].slice(-observeTiming.window);
            const facts = [];
            const worker = ROLE_SPECS[seat.role].watched;
            const ctx = this.context(state, seat);
            // An edit counts once its result shows it happened: a refused edit changed nothing.
            const ready = [];
            for (const step of fresh) {
                if (step.kind === "edit" && step.ref) {
                    w.pending.push({ step, at: this.now() });
                    continue;
                }
                if (step.kind === "result" && step.ref) {
                    const done = w.pending.filter((p) => p.step.ref === step.ref).map((p) => p.step);
                    w.pending = w.pending.filter((p) => p.step.ref !== step.ref);
                    if (step.failed === true)
                        w.steps = w.steps.filter((x) => !(x.kind === "edit" && x.ref === step.ref));
                    else
                        ready.push(...done);
                }
                ready.push(step);
            }
            const stale = w.pending.filter((p) => this.now() - p.at >= observeTiming.editResultMs);
            w.pending = w.pending.filter((p) => !stale.includes(p));
            ready.push(...stale.map((p) => p.step));
            const found = stepFacts(ready, ctx).map((f) => (ACCOUNT.has(f.fact) ? this.accountKey(seat, f) : f));
            facts.push(...found.filter((f) => worker || ACCOUNT.has(f.fact)).map((f) => (seat.role === "lead" ? leadWrote(f) : f)));
            for (const step of ready) {
                if (step.kind === "error" && !stepFacts([step], ctx).some((f) => ACCOUNT.has(f.fact))) {
                    await this.hooks.unknownError?.(project, state, config, seat, step);
                }
            }
            if (worker) {
                const stuck = stuckFact(w.steps);
                if (stuck)
                    facts.push(stuck);
            }
            const s = status.get(seat.paneId);
            if (s === "working") {
                w.workingSince ??= this.now();
                if (this.now() - w.workingSince > observeTiming.longTurnMs && worker) {
                    facts.push({ fact: "long_turn", level: "note", key: `long_turn:${w.workingSince}`,
                        text: `has been working on one turn for ${Math.round((this.now() - w.workingSince) / 60_000)} min` });
                }
            }
            else {
                if (w.workingSince !== null && worker)
                    await this.hooks.turnEnded?.(project, state, config, seat, w.steps);
                w.workingSince = null;
                if ((s === "idle" || s === "done") && this.now() - w.screenAt >= observeTiming.screenMs) {
                    w.screenAt = this.now();
                    const screen = await this.deps.herdr.agentRead(seat.paneId).catch(() => "");
                    const f = screenFact(screen);
                    if (f)
                        facts.push(this.accountKey(seat, f));
                }
            }
            for (const f of facts)
                await raise(this.deps, project.id, state, config, seat, f);
        }
        await this.ledgerShapes(project, state, config);
    }
    /**
     * One account problem, one incident: the transcript and the screen report
     * the same limit, so both share a key per seat session and day.
     */
    accountKey(seat, f) {
        return { ...f, key: `${f.fact}:${seat.name}:${seat.openedAt}:${new Date(this.now()).toISOString().slice(0, 10)}` };
    }
    context(state, seat) {
        const task = seat.task ? state.tasks.get(seat.task) : undefined;
        const lane = seat.lane ? state.lanes.get(seat.lane) : undefined;
        if (seat.role === "peer" && task)
            return { owned: task.owned, workdir: task.workdir };
        // A Lead writes no code at all: any edit in its copy is outside what it owns.
        if (seat.role === "lead" && lane)
            return { owned: [], workdir: lane.workdir };
        return { owned: null, workdir: lane?.workdir ?? "" };
    }
    async watched(seat, config) {
        const key = `${seat.paneId}:${seat.openedAt}`;
        let w = this.seats.get(seat.name);
        if (!w || w.key !== key) {
            w = { key, tail: null, lookedAt: 0, steps: [], screenAt: 0, workingSince: null, pending: [] };
            this.seats.set(seat.name, w);
        }
        if (!w.tail && this.now() - w.lookedAt >= observeTiming.lookupMs) {
            w.lookedAt = this.now();
            const path = await this.find(seat, config).catch(() => null);
            if (path)
                w.tail = new TranscriptTail(path, seat.agent === "codex" ? codexSteps : claudeSteps);
        }
        return w;
    }
    async find(seat, config) {
        if (seat.agent === "claude" && seat.sessionId)
            return findClaudeTranscript(this.deps.env, seat.sessionId);
        if (seat.agent === "codex" && seat.marker) {
            // Its own home first; a seat moved to another account may still write where it began.
            return findCodexRollout(codexHomes(config, this.deps.env, seat.launcher), seat.marker, new Date(seat.openedAt));
        }
        return null;
    }
    /** Facts about the record itself: hand-backs, reworks, reviews, briefs. */
    async ledgerShapes(project, state, config) {
        for (const task of state.tasks.values()) {
            const lead = leadOf(state, task.lane);
            const peer = state.seats.get(task.seat);
            const done = task.lastDone;
            const known = peer ? this.seats.get(peer.name) : undefined;
            // Check once the Peer's transcript has been read, or give up waiting for it.
            const readable = Boolean(known?.tail) || (done !== null && this.now() - Date.parse(done.ts) > observeTiming.handbackWaitMs);
            if (done && done.outcome === "complete" && readable && !this.checkedDone.has(`${done.seq}`)) {
                this.checkedDone.add(`${done.seq}`);
                const steps = known?.steps;
                const f = steps?.length ? unverifiedFact(steps, task.id) : null;
                if (f && peer)
                    await raise(this.deps, project.id, state, config, peer, f);
            }
            if (!lead)
                continue;
            const facts = [];
            if (task.reworks >= 3) {
                facts.push({ fact: "rework_loop", level: "attend", key: `rework_loop:${task.id}`, text: `sent ${task.id} back ${task.reworks} times` });
            }
            if (task.state === "accepted" && done && done.outcome !== "complete") {
                facts.push({ fact: "accepted_unfinished", level: "note", key: `accepted_unfinished:${task.id}`, text: `accepted ${task.id}, which was handed back as ${done.outcome}` });
            }
            if (/```|^\s*\d+\.\s+(edit|change|replace|add|insert|in)\b.*(line|file|function)/im.test(`${task.goal}\n${task.context}`)) {
                facts.push({ fact: "brief_prescribes", level: "note", key: `brief_prescribes:${task.id}`, text: `briefed ${task.id} with code or edit steps rather than an outcome` });
            }
            for (const f of facts)
                await raise(this.deps, project.id, state, config, lead, f);
        }
        for (const lane of state.lanes.values()) {
            if (!lane.open)
                continue;
            const lead = leadOf(state, lane.id);
            if (!lead)
                continue;
            const rounds = [...state.reviews.values()].filter((r) => r.lane === lane.id && r.done?.findings.some((x) => x.severity === "high"));
            if (rounds.length >= 3) {
                await raise(this.deps, project.id, state, config, lead, { fact: "reviews_not_converging", level: "attend", key: `reviews_not_converging:${lane.id}`, text: `has had ${rounds.length} reviews with high findings in ${lane.id}` });
            }
        }
    }
}
/** Codex homes to search: the launcher's own first, then every other one configured. */
export function codexHomes(config, env, first) {
    const fallback = env.CODEX_HOME || join(homedir(), ".codex");
    const homeOf = (name) => {
        const own = config.launchers[name]?.env.CODEX_HOME;
        return own ? expandHome(own) : fallback;
    };
    const names = Object.keys(config.launchers).filter((n) => config.launchers[n].agent === "codex");
    return [...new Set([...(first ? [homeOf(first)] : []), ...names.map(homeOf), fallback])];
}
function leadWrote(f) {
    return f.fact === "outside_owned" ? { ...f, fact: "lead_wrote", text: f.text.replace(/^edited outside its owned paths \(\): /, "wrote files itself (Leads brief Peers): ") } : f;
}
