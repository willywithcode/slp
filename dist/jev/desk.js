import { describe, sendLetter } from "../letters.js";
import { leadOf } from "../state.js";
import { raise } from "../watch/incidents.js";
import { consult, flagged } from "./points.js";
import { ASK, BRIEF, criticQuestions, FAILURE_MODE, HANDBACK, LANE, SENSOR, TURN_END, USAGE } from "./questions.js";
// Where the watcher meets Jev: events and turn ends become decision points.
// Code fallbacks come first and always run (ADR 0013); Jev readings are
// recorded, shown to seats as shadow notes for calibration, and act only
// where calibrated.
export const deskTiming = {
    /** A Peer idle this long after its turn, with no hand-back or ask, gets one nudge. */
    nudgeMs: 3 * 60_000,
    /** Still nothing this long after the turn: its Lead is told. */
    escalateMs: 10 * 60_000,
    /** Events older than this are not read for the first time (Jev switched on later). */
    freshMs: 60 * 60_000,
};
/** Questions whose trusted "yes" is an incident about the seat (catalogue 11, 18). */
const INCIDENT_QUESTIONS = new Set([...Object.keys(SENSOR), "claim_contradicted"]);
function clip(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** A compact view of a seat's last steps for Jev's state. */
function view(steps, max = 40) {
    return steps.slice(-max).map((s) => ({ kind: s.kind, text: clip(s.text, 400) }));
}
export class JevDesk {
    deps;
    turns = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    now() { return this.deps.now?.() ?? Date.now(); }
    async notice(project, to, text, seat) {
        await sendLetter(this.deps, project.id, { letter: "NOTICE", from: "slp", to, lane: seat?.lane ?? null, task: seat?.task ?? null, text })
            .catch((error) => this.deps.out(`could not tell ${to}: ${describe(error)}`));
    }
    /**
     * What Jev flagged becomes an incident about the seat: an unmailed note
     * while uncalibrated (seats may mark it, which feeds `slp calibrate`), an
     * incident routed like any other once its question is trusted.
     */
    async shadow(project, state, config, seat, point, subject, reading) {
        for (const f of flagged(reading)) {
            // Only sensor readings become routed incidents; flow decisions act through their own letters.
            const trusted = INCIDENT_QUESTIONS.has(f.question) && reading.trusted(f.question, f.choice);
            const fact = { fact: `jev:${point}.${f.question}`, level: trusted ? "attend" : "note", key: `jev:${point}.${f.question}:${subject}`,
                text: `Jev reads ${f.question.replace(/_/g, " ")} = ${f.choice} (${f.confidence.toFixed(2)})` };
            await raise(this.deps, project.id, state, config, seat, fact, { quiet: !trusted });
        }
    }
    /** A worker's turn ended (working → idle). */
    async turnEnded(project, state, config, seat, steps) {
        if (seat.role !== "peer" && seat.role !== "lead")
            return;
        const task = seat.task ? state.tasks.get(seat.task) : undefined;
        const open = task && (task.state === "running" || task.state === "rework");
        if (seat.role === "peer" && open)
            this.turns.set(seat.name, { at: this.now(), nudged: false, escalated: false });
        const subject = `${seat.name}@${steps.at(-1)?.at ?? this.now()}`;
        const questions = seat.role === "peer" && open ? { ...SENSOR, ...TURN_END } : SENSOR;
        const reading = await consult(this.deps, project.id, config, "turn", subject, {
            seat: { name: seat.name, role: seat.role },
            brief: task ? { title: task.title, goal: task.goal, acceptance: task.acceptance, owned: task.owned } : null,
            steps: view(steps),
        }, questions);
        if (!reading)
            return;
        await this.shadow(project, state, config, seat, "turn", subject, reading);
        if (!open)
            return;
        const turn = this.turns.get(seat.name);
        if (reading.trusted("turn_end_state", "finished_unreported") && turn && !turn.nudged) {
            turn.nudged = true;
            await this.nudge(project, seat);
        }
        else if (reading.trusted("turn_end_state", "stuck") && turn && !turn.escalated) {
            turn.escalated = true;
            const lead = seat.lane ? leadOf(state, seat.lane) : null;
            if (lead)
                await this.notice(project, lead.name, `${seat.name} looks stuck in ${seat.task} (Jev, ${reading.answers.turn_end_state.confidence.toFixed(2)}). Look at its pane or its last hand-back.`, seat);
        }
        else if (reading.trusted("turn_end_state", "needs_permission")) {
            await this.deps.herdr.notify(`slp: ${seat.name} waits on you`, `A prompt in pane ${seat.paneId} likely needs the Human.`).catch(() => undefined);
        }
    }
    async nudge(project, seat) {
        await sendLetter(this.deps, project.id, { letter: "NUDGE", from: "slp", to: seat.name, lane: seat.lane, task: seat.task,
            text: `Your turn ended without handing ${seat.task} back. If it is done, hand it back with \`slp done\`; if you are stuck, \`slp ask\`; if you are still working, carry on.` })
            .catch((error) => this.deps.out(`could not nudge ${seat.name}: ${describe(error)}`));
    }
    /** The fallback for turn ends (catalogue 9): one nudge, then the Lead. Runs every tick, Jev or not. */
    async timers(project, state, status) {
        for (const [name, turn] of [...this.turns]) {
            const seat = state.seats.get(name);
            const task = seat?.task ? state.tasks.get(seat.task) : undefined;
            const s = seat ? status.get(seat.paneId) : undefined;
            if (!seat?.live || !task || (task.state !== "running" && task.state !== "rework") || s === "working" || s === "blocked") {
                this.turns.delete(name);
                continue;
            }
            // Waiting on an answer is not idling: the clock starts again once it comes.
            if ([...state.asks.values()].some((a) => a.from === name && a.answer === null)) {
                turn.at = this.now();
                continue;
            }
            const idle = this.now() - turn.at;
            if (!turn.nudged && idle >= deskTiming.nudgeMs) {
                turn.nudged = true;
                await this.nudge(project, seat);
            }
            else if (turn.nudged && !turn.escalated && idle >= deskTiming.escalateMs) {
                turn.escalated = true;
                const lead = leadOf(state, task.lane);
                if (lead)
                    await this.notice(project, lead.name, `${name} has been idle ${Math.round(idle / 60_000)} min without handing ${task.id} back, even after a nudge. Look at its pane.`, seat);
            }
        }
    }
    /** An API error no pattern recognised: is the account out? (catalogue 17) */
    async unknownError(project, state, config, seat, step) {
        const subject = `${seat.name}@${step.at}`;
        const reading = await consult(this.deps, project.id, config, "usage", subject, { agent: seat.agent, error: clip(step.text, 1500) }, USAGE);
        if (reading?.trusted("usage_limit", "limit_reached")) {
            await raise(this.deps, project.id, state, config, seat, { fact: "usage_limit", level: "attend", key: `usage_limit:jev:${step.at}`,
                text: `its account looks out of usage (Jev, ${reading.answers.usage_limit.confidence.toFixed(2)}): ${clip(step.text, 200)}` });
        }
    }
    /** New events become decision points: asks, briefs, hand-backs, lanes, closed lanes. */
    async events(project, state, config, events, transcripts) {
        const now = this.now();
        for (const e of events) {
            if (now - Date.parse(e.ts) > deskTiming.freshMs)
                continue;
            if (e.kind === "ask")
                await this.ask(project, state, config, e);
            else if (e.kind === "task-start")
                await this.brief(project, state, config, e);
            else if (e.kind === "task-done")
                await this.handback(project, state, config, e, transcripts(state.tasks.get(e.task)?.seat ?? ""));
            else if (e.kind === "lane-open")
                await this.lane(project, state, config, e);
            else if (e.kind === "lane-close")
                await this.retrospective(project, state, config, e.lane);
        }
    }
    async ask(project, state, config, e) {
        const asker = state.seats.get(e.from);
        if (!asker)
            return;
        const reading = await consult(this.deps, project.id, config, "ask", String(e.seq), {
            ask: { text: e.text, type: e.type, from: { seat: e.from, role: asker.role }, to: e.to },
            lane: asker.lane ? { outcome: state.lanes.get(asker.lane)?.outcome ?? null } : null,
        }, ASK);
        if (!reading)
            return;
        await this.shadow(project, state, config, asker, "ask", String(e.seq), reading);
        if (e.to === "human")
            return;
        if (reading.trusted("decision_owner", "human_concept")) {
            await this.notice(project, e.to, `${e.ask} reads as the Human's call (Jev, ${reading.answers.decision_owner.confidence.toFixed(2)}): it concerns what the project does. Take it to the Human rather than deciding.`, asker);
        }
        else {
            const route = reading.answers.ask_route.choice;
            const target = route === "supervisor" ? "sup" : route === "lead" ? asker.lane : null;
            if (target && target !== e.to && reading.trusted("ask_route", route)) {
                await this.notice(project, e.to, `${e.ask} might be better answered by ${route === "supervisor" ? "the Supervisor" : "the lane's Lead"} (Jev, ${reading.answers.ask_route.confidence.toFixed(2)}).`, asker);
            }
        }
    }
    async brief(project, state, config, e) {
        const lead = leadOf(state, e.lane);
        if (!lead)
            return;
        const preset = state.seats.get(e.seat);
        const reading = await consult(this.deps, project.id, config, "brief", e.task, {
            brief: { title: e.title, goal: e.goal, acceptance: e.acceptance, owned: e.owned, outOfScope: e.outOfScope, context: e.context },
            model: preset?.model ?? null,
        }, BRIEF);
        if (!reading)
            return;
        await this.shadow(project, state, config, lead, "brief", e.task, reading);
        const q = reading.answers.brief_quality;
        if (q.choice !== "ok" && q.choice !== "unsure" && reading.trusted("brief_quality", q.choice)) {
            await this.notice(project, lead.name, `The brief for ${e.task} reads as ${q.choice.replace(/_/g, " ")} (Jev, ${q.confidence.toFixed(2)}). Consider \`slp message ${e.task}\` with the outcome instead.`);
        }
    }
    async handback(project, state, config, e, steps) {
        const task = state.tasks.get(e.task);
        const lead = task ? leadOf(state, task.lane) : null;
        const peer = task ? state.seats.get(task.seat) : undefined;
        if (!task || !lead || !peer)
            return;
        const reading = await consult(this.deps, project.id, config, "handback", String(e.seq), {
            brief: { goal: task.goal, acceptance: task.acceptance },
            handback: { outcome: e.outcome, summary: clip(e.summary, 3000), checks: e.checks, left: e.leftUndone },
            steps: view(steps, 30),
        }, HANDBACK);
        if (!reading)
            return;
        await this.shadow(project, state, config, peer, "handback", String(e.seq), reading);
        const notes = [];
        const form = reading.answers.handback_form;
        if ((form.choice === "missing_evidence" || form.choice === "status_unclear") && reading.trusted("handback_form", form.choice))
            notes.push(`the hand-back reads as ${form.choice.replace(/_/g, " ")}`);
        const review = reading.answers.needs_review;
        if ((review.choice === "yes" || review.choice === "yes_risky") && reading.trusted("needs_review", review.choice))
            notes.push(`a review looks worth it (\`slp start-review --task ${task.id}\`)`);
        if (notes.length)
            await this.notice(project, lead.name, `On ${task.id} (Jev): ${notes.join("; ")}.`);
    }
    async lane(project, state, config, e) {
        const sup = state.seats.get("sup");
        if (!sup?.live)
            return;
        const reading = await consult(this.deps, project.id, config, "lane", e.lane, {
            lane: { title: e.title, outcome: e.outcome, acceptance: e.acceptance, outOfScope: e.outOfScope, writeSet: e.writeSet },
            humanWords: clip(e.humanWords, 4000),
        }, LANE);
        if (!reading)
            return;
        await this.shadow(project, state, config, sup, "lane", e.lane, reading);
        const d = reading.answers.directive_quality;
        const notes = [];
        if ((d.choice === "weak" || d.choice === "missing") && reading.trusted("directive_quality", d.choice))
            notes.push(`its directive reads as ${d.choice}; consider \`slp amend-lane ${e.lane}\``);
        if (reading.trusted("lane_risk", "high"))
            notes.push("it reads as high risk: have its Lead plan and get a review, and show the Human before landing");
        if (notes.length)
            await this.notice(project, "sup", `${e.lane} (Jev): ${notes.join("; ")}.`);
    }
    /** Catalogue 20: why the lane's incidents and reworks happened; recorded for the retrospective only. */
    async retrospective(project, state, config, laneId) {
        const items = {};
        for (const i of state.incidents) {
            const seat = state.seats.get(i.seat);
            if (seat?.lane === laneId && !i.fact.startsWith("jev:"))
                items[i.incident] = `${i.seat} ${i.fact}: ${i.text}`;
        }
        for (const t of state.tasks.values())
            if (t.lane === laneId && t.reworks)
                items[`${t.id}-rework`] = `${t.id} sent back ${t.reworks} time(s)`;
        const names = Object.keys(items).slice(0, 12);
        if (!names.length)
            return;
        await consult(this.deps, project.id, config, "retrospective", laneId, { items }, Object.fromEntries(names.map((n) => [n.replace(/[^A-Za-z0-9_]/g, "_"), FAILURE_MODE])));
    }
}
/** Catalogue 19: a first pass over the lane for the Critic (context only). */
export async function criticPrefilter(deps, project, config, lane, concept) {
    if (!lane.acceptance.length)
        return null;
    const reading = await consult(deps, project, config, "critic", lane.id, { humanWords: clip(lane.humanWords, 4000), concept: clip(concept, 4000), acceptance: lane.acceptance }, criticQuestions(lane.acceptance));
    if (!reading)
        return null;
    // Only a calibrated first pass reaches the Critic; in shadow it is recorded, not shown.
    const threshold = config.jev.thresholds["critic.prefilter"];
    if (config.jev.mode !== "on" || threshold === undefined)
        return null;
    const lines = lane.acceptance.flatMap((item, i) => {
        const a = reading.answers[`item_${i + 1}`];
        return a && a.choice !== "none" && a.choice !== "unsure" && a.confidence >= threshold ? [`- "${item}": possibly ${a.choice} (${a.confidence.toFixed(2)})`] : [];
    });
    return lines.length ? `A machine first pass (Jev) flagged these; check them yourself, they may be wrong:\n${lines.join("\n")}` : null;
}
