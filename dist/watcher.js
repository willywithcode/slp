import { GoneError } from "./core/errors.js";
import { append, readLedger } from "./core/ledger.js";
import { loadProject } from "./core/project.js";
import { loadConfig } from "./core/config.js";
import { choicePrompt, permissionPrompt } from "./permit.js";
import { pendingRequests, runRequest } from "./land.js";
import { openQueued, queuedReady, teardownLane } from "./lanes.js";
import { sweepKept } from "./slots.js";
import { describe, pump, sendLetter, showsStartupDialog } from "./letters.js";
import { closeSeat } from "./seats.js";
import { fold, liveSeats, superiorOf } from "./state.js";
import { JevDesk } from "./jev/desk.js";
import { Observer } from "./watch/observer.js";
// The watcher (ADR 0009): code, not a seat. It relays waiting letters, runs
// gates and landings, and keeps the team moving with a few plain rules.
// Phase 4 adds transcript facts and incidents; Jev (ADR 0013) is optional.
export const watchTiming = {
    /** Defaults for the config's watch timings (ADR 0020). A seat stuck on a prompt in its pane this long is reported. */
    blockedMs: 3 * 60_000,
    /** An unanswered ask is reminded after this long, then as often again. */
    askReminderMs: 10 * 60_000,
    askReminders: 3,
    /** Ticks a live seat's pane may be missing from Herdr before it counts as gone. */
    goneTicks: 3,
    /** A permission prompt the Supervisor answers is passed on after this long (it may clear by itself). */
    permitAfterMs: 20_000,
    /** Kept working copies are tried again this often. */
    sweepMs: 10 * 60_000,
};
/** An idle seat's screen is read for a prompt at most this often. */
const PEEK_MS = 10_000;
export class Watcher {
    deps;
    projectId;
    inflight = null;
    blockedSince = new Map();
    blockedTold = new Set();
    missing = new Map();
    /** When an idle seat's screen was last read for a prompt. */
    peeked = new Map();
    /** Seats whose mail waits behind a startup dialog, already reported to the Human. */
    dialogTold = new Set();
    observer;
    desk;
    /** The last ledger event handed to the decision points. */
    seen = 0;
    lastSweep = 0;
    constructor(deps, projectId) {
        this.deps = deps;
        this.projectId = projectId;
        this.desk = new JevDesk(deps);
        this.observer = new Observer(deps, {
            turnEnded: (project, state, config, seat, steps) => this.desk.turnEnded(project, state, config, seat, steps),
            unknownError: (project, state, config, seat, step) => this.desk.unknownError(project, state, config, seat, step),
        });
    }
    now() { return this.deps.now?.() ?? Date.now(); }
    /** One pass. Throws GoneError when the project no longer exists. */
    async tick() {
        const project = await loadProject(this.deps.env, this.projectId);
        if (!project)
            throw new GoneError(`Project ${this.projectId} does not exist`);
        const pumped = await pump(this.deps, project.id);
        for (const seat of pumped.atDialog) {
            if (this.dialogTold.has(seat))
                continue;
            this.dialogTold.add(seat);
            await this.deps.herdr.notify(`slp: ${seat} waits on you`, "A startup dialog (folder trust) in its pane needs the Human; its letters wait.").catch(() => undefined);
        }
        for (const seat of pumped.unreadable) {
            if (this.dialogTold.has(seat))
                continue;
            this.dialogTold.add(seat);
            await this.deps.herdr.notify(`slp: cannot read ${seat}'s screen`, "Its letters wait until slp can see the pane is clear (Herdr may be busy).").catch(() => undefined);
        }
        const waiting = [...pumped.atDialog, ...pumped.unreadable];
        for (const seat of [...this.dialogTold])
            if (!waiting.includes(seat))
                this.dialogTold.delete(seat);
        this.startRequest(project, await readLedger(this.deps.env, project.id));
        const state = fold(await readLedger(this.deps.env, project.id));
        await this.tidy(project, state);
        this.openNext(project, state);
        if (state.keptSlots.size && this.now() - this.lastSweep >= watchTiming.sweepMs && !this.inflight) {
            this.lastSweep = this.now();
            await sweepKept(this.deps, project, state).catch((error) => this.deps.out(`sweep: ${describe(error)}`));
        }
        const agents = await this.deps.herdr.agentList().catch(() => null);
        if (agents) {
            const status = new Map(agents.map((a) => [a.paneId, a.status]));
            const config = await loadConfig(this.deps.env).catch((error) => {
                this.deps.out(`watch: ${describe(error)}`);
                return null;
            });
            await this.checkPanes(project, state, status, config);
            await this.retire(project, state, status);
            if (config) {
                await this.observer.observe(project, state, config, status);
                await this.desk.timers(project, state, status);
                const events = await readLedger(this.deps.env, project.id);
                const fresh = events.filter((e) => e.seq > this.seen);
                this.seen = events.at(-1)?.seq ?? this.seen;
                await this.desk.events(project, state, config, fresh, (seat) => this.observer.steps(seat));
            }
        }
        await this.remindAsks(project, state);
    }
    /** A lane closed while its seats still run (a drop cut short by a crash): finish closing it. */
    async tidy(project, state) {
        if (this.inflight)
            return; // a landing in progress tidies its own lane
        for (const lane of state.lanes.values()) {
            if (lane.open || !liveSeats(state).some((s) => s.lane === lane.id))
                continue;
            const problems = await teardownLane(this.deps, project, lane, state);
            this.deps.out(`closed the seats of ${lane.id}, which was already closed${problems.length ? `; ${problems.join("; ")}` : ""}`);
        }
    }
    /** Open a queued lane once the lane it waits for has closed, as a landing does: one thing at a time. */
    openNext(project, state) {
        if (this.inflight)
            return;
        const next = queuedReady(state);
        if (!next)
            return;
        this.deps.out(`opening ${next.lane}: ${next.after} has closed`);
        this.inflight = openQueued(this.deps, project, next)
            .catch((error) => this.deps.out(`${next.lane} could not open: ${describe(error)}`))
            .finally(() => { this.inflight = null; });
    }
    /** Wait for a gate or landing in progress (tests, shutdown). */
    async settle() {
        while (this.inflight)
            await this.inflight;
    }
    startRequest(project, events) {
        if (this.inflight)
            return;
        const next = pendingRequests(events)[0];
        if (!next)
            return;
        this.deps.out(`working on ${next.request}: ${next.what} ${next.lane}`);
        this.inflight = runRequest(this.deps, project, next)
            .catch(async (error) => {
            this.deps.out(`${next.request} failed: ${describe(error)}`);
            await append(this.deps.env, project.id, () => ({
                kind: "request-done", request: next.request, ok: false, detail: `slp error: ${describe(error)}`,
            })).catch(() => undefined);
            await this.tell(project, fold(events), "sup", `slp could not finish ${next.what} for ${next.lane}: ${describe(error)}`, next.lane);
        })
            .finally(() => { this.inflight = null; });
    }
    async tell(project, state, to, text, lane) {
        const target = to && state.seats.get(to)?.live ? to : "human";
        await sendLetter(this.deps, project.id, { letter: "NOTICE", from: "slp", to: target, lane, text })
            .catch((error) => this.deps.out(`could not tell ${target}: ${describe(error)}`));
    }
    /** Seats whose pane is gone, or that wait on a prompt: each goes to whoever answers it (ADR 0016, 0020). */
    async checkPanes(project, state, status, config) {
        const permitAfter = config?.watch.permitAfterMs ?? watchTiming.permitAfterMs;
        const blockedAfter = config?.watch.blockedMs ?? watchTiming.blockedMs;
        for (const seat of liveSeats(state)) {
            const s = status.get(seat.paneId);
            if (s === undefined) {
                const n = (this.missing.get(seat.name) ?? 0) + 1;
                this.missing.set(seat.name, n);
                if (n >= watchTiming.goneTicks) {
                    this.missing.delete(seat.name);
                    await append(this.deps.env, project.id, () => ({ kind: "seat-stop", name: seat.name, reason: "its pane is gone" }));
                    await this.tell(project, state, superiorOf(state, seat), `${seat.name} (${seat.role}) is gone: its pane ${seat.paneId} no longer runs an agent.`, seat.lane);
                }
                continue;
            }
            this.missing.delete(seat.name);
            const waiting = await this.promptOf(seat, s);
            if (!waiting) {
                this.blockedSince.delete(seat.name);
                this.blockedTold.delete(seat.name);
                continue;
            }
            const since = this.blockedSince.get(seat.name) ?? this.now();
            this.blockedSince.set(seat.name, since);
            if (this.blockedTold.has(seat.name))
                continue;
            // A permission prompt goes to the Supervisor while the Human is out of
            // the loop, after a moment (it may clear by itself). The Human's own
            // (the Supervisor's prompts, or every one with the Human in the loop)
            // reach them at once; a Yes/No slp does not recognise after that
            // moment; any other prompt after blockedMs.
            const toSup = waiting.kind === "permission" && config !== null && !config.human.inLoop &&
                seat.name !== "sup" && state.seats.get("sup")?.live === true;
            const wait = toSup || waiting.kind === "choice" ? permitAfter : waiting.kind === "permission" ? 0 : blockedAfter;
            if (this.now() - since < wait)
                continue;
            this.blockedTold.add(seat.name);
            if (toSup) {
                await this.tell(project, state, "sup", `${seat.name} asks permission for:\n${waiting.text}\n\n` +
                    `Answer it for the Human: \`slp permit ${seat.name} allow "why"\` or \`slp permit ${seat.name} deny "why"\`.`, seat.lane);
                continue;
            }
            const what = waiting.kind === "choice" ? `A prompt slp does not recognise waits in its pane:\n${waiting.text}`
                : waiting.text ?? `A prompt in pane ${seat.paneId} needs the Human.`;
            await this.deps.herdr.notify(`slp: ${seat.name} waits on you`, what).catch(() => undefined);
            const up = superiorOf(state, seat);
            if (up) {
                const mins = Math.round((this.now() - since) / 60_000);
                await this.tell(project, state, up, `${seat.name} waits on a prompt in its pane${mins ? ` (${mins} min)` : ""}; the Human was notified.` +
                    (waiting.kind === "choice" ? `\n${waiting.text}` : ""), seat.lane);
            }
        }
    }
    /**
     * What a seat waits on, if anything: a permission prompt slp knows, a
     * Yes/No it does not (ADR 0020), or another prompt Herdr reports. An idle
     * seat's screen is read too (Herdr may not see such a prompt), at most every
     * PEEK_MS unless something was already seen there.
     */
    async promptOf(seat, s) {
        if (s === "working")
            return null;
        if (s !== "blocked" && !this.blockedSince.has(seat.name)) {
            if (this.now() - (this.peeked.get(seat.name) ?? -Infinity) < PEEK_MS)
                return null;
            this.peeked.set(seat.name, this.now());
        }
        const screen = await this.deps.herdr.agentRead(seat.paneId).catch(() => "");
        // A startup dialog is the Human's, reported where letters wait (pump).
        if (showsStartupDialog(screen))
            return null;
        const known = permissionPrompt(screen);
        if (known)
            return { kind: "permission", text: known.excerpt };
        const choice = choicePrompt(screen);
        if (choice)
            return { kind: "choice", text: choice };
        return s === "blocked" ? { kind: "other", text: null } : null;
    }
    /** Close Reviewer and Critic seats that have reported, once their turn ends. */
    async retire(project, state, status) {
        for (const seat of liveSeats(state)) {
            if (!finished(state, seat))
                continue;
            const s = status.get(seat.paneId);
            if (s === "working" || s === "blocked")
                continue;
            await closeSeat(this.deps, project.id, seat, "reported");
            this.deps.out(`closed ${seat.name}: it has reported`);
        }
    }
    async remindAsks(project, state) {
        for (const ask of state.asks.values()) {
            if (ask.answer !== null || ask.to === "human")
                continue;
            if (!state.seats.get(ask.to)?.live || !state.seats.get(ask.from)?.live)
                continue;
            const reminders = state.letters.filter((l) => l.letter === "STILL_OPEN" && l.text.startsWith(`${ask.id} `));
            if (reminders.length >= watchTiming.askReminders)
                continue;
            const last = Date.parse(reminders.at(-1)?.ts ?? ask.askedAt);
            if (this.now() - last < watchTiming.askReminderMs)
                continue;
            await sendLetter(this.deps, project.id, { letter: "STILL_OPEN", from: "slp", to: ask.to,
                text: `${ask.id} from ${ask.from} is unanswered after ${Math.round((this.now() - Date.parse(ask.askedAt)) / 60_000)} min: ${ask.text}` })
                .catch((error) => this.deps.out(`could not remind ${ask.to}: ${describe(error)}`));
        }
    }
}
function finished(state, seat) {
    if (seat.role === "reviewer")
        return [...state.reviews.values()].some((r) => r.seat === seat.name && r.done);
    if (seat.role === "critic")
        return state.letters.some((l) => l.from === seat.name && l.letter === "CRITIQUE");
    return false;
}
