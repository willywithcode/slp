export function fold(events) {
    const s = {
        settings: { base: "main", gate: null, gateTimeoutMinutes: 30, landAs: "squash" },
        seats: new Map(), letters: [], lanes: new Map(), tasks: new Map(), reviews: new Map(), asks: new Map(),
        gates: [], reports: [], incidents: [], acks: [],
    };
    const letters = new Map();
    for (const e of events) {
        switch (e.kind) {
            case "project":
                s.settings = { base: e.base, gate: e.gate, gateTimeoutMinutes: e.gateTimeoutMinutes, landAs: e.landAs };
                break;
            case "seat":
                s.seats.set(e.name, {
                    name: e.name, role: e.role, lane: e.lane, task: e.task, launcher: e.launcher, agent: e.agent, model: e.model,
                    effort: e.effort, paneId: e.paneId, tabId: e.tabId, sessionId: e.sessionId, marker: e.marker, live: true, openedAt: e.ts,
                });
                break;
            case "seat-stop": {
                const seat = s.seats.get(e.name);
                if (seat)
                    seat.live = false;
                break;
            }
            case "letter":
                letters.set(e.seq, {
                    seq: e.seq, ts: e.ts, letter: e.letter, from: e.from, to: e.to, text: e.text, lane: e.lane, task: e.task,
                    status: "unconfirmed", queueReason: null, error: null, lastAttemptAt: null,
                });
                break;
            case "delivery": {
                const l = letters.get(e.ref);
                if (!l)
                    break;
                l.lastAttemptAt = e.ts;
                if (l.status === "delivered")
                    break; // a later attempt never undoes a delivery
                if (e.ok) {
                    l.status = "delivered";
                    l.queueReason = null;
                    l.error = null;
                }
                else if (e.stage === "queued") {
                    l.status = "queued";
                    l.queueReason = e.reason ?? null;
                    l.error = e.error;
                }
                else if (e.stage === "relaying") {
                    l.status = "relaying";
                }
                else {
                    l.status = "failed";
                    l.error = e.error;
                }
                break;
            }
            case "lane-open":
                s.lanes.set(e.lane, {
                    id: e.lane, title: e.title, outcome: e.outcome, acceptance: e.acceptance, outOfScope: e.outOfScope,
                    writeSet: e.writeSet, branch: e.branch, workdir: e.workdir, inCheckout: e.inCheckout, base: e.base,
                    baseCommit: e.baseCommit, humanWords: e.humanWords, open: true, landed: false, commit: null, openedAt: e.ts,
                });
                break;
            case "lane-amend": {
                const lane = s.lanes.get(e.lane);
                if (!lane)
                    break;
                if (e.outcome !== undefined)
                    lane.outcome = e.outcome;
                if (e.acceptance !== undefined)
                    lane.acceptance = e.acceptance;
                if (e.outOfScope !== undefined)
                    lane.outOfScope = e.outOfScope;
                if (e.writeSet !== undefined)
                    lane.writeSet = e.writeSet;
                break;
            }
            case "lane-close": {
                const lane = s.lanes.get(e.lane);
                if (lane) {
                    lane.open = false;
                    lane.landed = e.landed;
                    lane.commit = e.commit;
                }
                break;
            }
            case "task-start":
                s.tasks.set(e.task, {
                    id: e.task, lane: e.lane, title: e.title, goal: e.goal, acceptance: e.acceptance, owned: e.owned,
                    outOfScope: e.outOfScope, context: e.context, mode: e.mode, branch: e.branch, workdir: e.workdir,
                    baseCommit: e.baseCommit, seat: e.seat, state: "running", reworks: 0, lastDone: null,
                });
                break;
            case "task-done": {
                const t = s.tasks.get(e.task);
                if (t) {
                    t.state = "handed-back";
                    t.lastDone = e;
                }
                break;
            }
            case "task-rework": {
                const t = s.tasks.get(e.task);
                if (t) {
                    t.state = "rework";
                    t.reworks += 1;
                }
                break;
            }
            case "task-accept": {
                const t = s.tasks.get(e.task);
                if (t)
                    t.state = "accepted";
                break;
            }
            case "task-cut": {
                const t = s.tasks.get(e.task);
                if (t)
                    t.state = "cut";
                break;
            }
            case "review-start":
                s.reviews.set(e.review, { id: e.review, lane: e.lane, target: e.target, focus: e.focus, seat: e.seat, done: null });
                break;
            case "review-done": {
                const r = s.reviews.get(e.review);
                if (r)
                    r.done = e;
                break;
            }
            case "ask":
                s.asks.set(e.ask, { id: e.ask, from: e.from, to: e.to, type: e.type, text: e.text, default: e.default, askedAt: e.ts, answer: null });
                break;
            case "answer": {
                const a = s.asks.get(e.ask);
                if (a)
                    a.answer = e.text;
                break;
            }
            case "gate":
                s.gates.push(e);
                break;
            case "report":
                s.reports.push(e);
                break;
            case "incident":
                s.incidents.push(e);
                break;
            case "ack":
                s.acks.push(e);
                break;
            default: break;
        }
    }
    s.letters = [...letters.values()];
    return s;
}
export function liveSeats(s) {
    return [...s.seats.values()].filter((x) => x.live);
}
/** The Lead seat of a lane (seat name equals the lane id). */
export function leadOf(s, lane) {
    const seat = s.seats.get(lane);
    return seat && seat.role === "lead" && seat.live ? seat : null;
}
/** Who answers for a seat: a lane's seats → its Lead; a Lead → the Supervisor. */
export function superiorOf(s, seat) {
    if (seat.role === "supervisor")
        return null;
    if (seat.role === "lead" || seat.role === "critic")
        return "sup";
    return seat.lane && leadOf(s, seat.lane) ? seat.lane : "sup";
}
