const STATE = {
    brief: "awaiting-handback",
    handback: "awaiting-lead",
    reply: "lead-replied",
};
/** Fold the log into cases. States are facts about the last message, never judgments. */
export function foldCases(events) {
    const cases = new Map();
    const delivered = new Set();
    const last = new Map();
    for (const e of events) {
        if (e.kind !== "delivery")
            continue;
        if (e.ok)
            delivered.add(e.ref);
        last.set(e.ref, e);
    }
    for (const e of events) {
        if (e.kind === "delivery" || e.kind === "alert" || e.kind === "assessment")
            continue;
        if (e.kind === "brief") {
            cases.set(e.case, { id: e.case, lead: e.from, peer: e.to, state: STATE.brief, messages: [], undelivered: [], failed: [], unconfirmed: [], queued: [], errors: {} });
        }
        const view = cases.get(e.case);
        if (!view)
            continue;
        view.messages.push(e);
        view.state = e.kind === "reply" && e.closes ? "closed" : STATE[e.kind];
        if (e.kind !== "handback")
            view.peer = e.to;
        const attempt = last.get(e.seq);
        // A resend queued after an earlier delivery still waits for the watcher.
        if (attempt?.stage === "queued")
            view.queued.push(e.seq);
        if (delivered.has(e.seq))
            continue;
        view.undelivered.push(e.seq);
        if (attempt?.stage === "queued") {
            // counted above
        }
        else if (!attempt || attempt.stage === "relaying") {
            view.unconfirmed.push(e.seq);
        }
        else {
            view.failed.push(e.seq);
            view.errors[e.seq] = attempt.error ?? "unknown error";
        }
    }
    return cases;
}
