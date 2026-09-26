const STATE = {
    brief: "awaiting-handback",
    handback: "awaiting-lead",
    reply: "lead-replied",
};
/** Fold the log into cases. States are facts about the last message, never judgments. */
export function foldCases(events) {
    const cases = new Map();
    const delivered = new Set();
    const errors = new Map();
    for (const e of events) {
        if (e.kind !== "delivery")
            continue;
        if (e.ok)
            delivered.add(e.ref);
        else
            errors.set(e.ref, e.error ?? "unknown error");
    }
    for (const e of events) {
        if (e.kind === "delivery" || e.kind === "alert" || e.kind === "assessment")
            continue;
        if (e.kind === "brief") {
            cases.set(e.case, { id: e.case, lead: e.from, peer: e.to, state: STATE.brief, messages: [], undelivered: [], failed: [], unconfirmed: [], errors: {} });
        }
        const view = cases.get(e.case);
        if (!view)
            continue;
        view.messages.push(e);
        view.state = e.kind === "reply" && e.closes ? "closed" : STATE[e.kind];
        if (e.kind !== "handback")
            view.peer = e.to;
        if (delivered.has(e.seq))
            continue;
        view.undelivered.push(e.seq);
        const error = errors.get(e.seq);
        if (error === undefined) {
            view.unconfirmed.push(e.seq);
        }
        else {
            view.failed.push(e.seq);
            view.errors[e.seq] = error;
        }
    }
    return cases;
}
