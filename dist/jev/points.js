import { append, readLedger } from "../core/ledger.js";
import { jevFromEnv } from "./client.js";
function today(ts, now) {
    return now - Date.parse(ts) < 86_400_000;
}
/** Ask Jev once about one subject (e.g. an event's seq) at one point; null means: use the fallback. */
export async function consult(deps, project, config, point, subject, state, questions) {
    if (config.jev.mode === "off")
        return null;
    let jev;
    try {
        jev = jevFromEnv(deps.env, deps.fetch);
    }
    catch {
        return null;
    }
    if (!jev)
        return null;
    const events = await readLedger(deps.env, project);
    const now = deps.now?.() ?? Date.now();
    if (events.some((e) => e.kind === "jev" && e.point === point && e.subject === subject))
        return null;
    if (events.filter((e) => e.kind === "jev" && today(e.ts, now)).length >= config.jev.dailyCalls)
        return null;
    const answers = await jev.ask(state, questions);
    const mode = config.jev.mode === "on" ? "act" : "shadow";
    await append(deps.env, project, () => ({
        kind: "jev", point, subject, mode,
        answers: answers ? Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, { choice: a.choice, confidence: a.confidence }])) : null,
        acted: false,
    }));
    if (!answers)
        return null;
    return {
        answers,
        trusted(question, label) {
            const a = answers[question];
            const threshold = config.jev.thresholds[`${point}.${question}`];
            return mode === "act" && threshold !== undefined && a?.choice === label && a.confidence >= threshold;
        },
    };
}
/** Labels that mean "nothing to act on". */
const QUIET = new Set(["no", "none", "unsure", "ok", "complete", "low", "still_working", "waiting_answer"]);
/** Questions a reading flags (a non-quiet answer), for shadow incidents that feed calibration. */
export function flagged(reading) {
    return Object.entries(reading.answers)
        .filter(([, a]) => !QUIET.has(a.choice))
        .map(([question, a]) => ({ question, choice: a.choice, confidence: a.confidence }));
}
