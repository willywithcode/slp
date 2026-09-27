/**
 * A threshold needs enough marks overall, both kinds among them (or there is
 * nothing to separate), and enough useful readings at or above it.
 */
export const calibration = { minMarks: 5, minNoise: 2, minUsefulAbove: 3, precision: 0.8 };
/** A shadow reading's question and subject, from its incident key `jev:<point>.<question>:<subject>`. */
function parseKey(key) {
    const m = /^jev:([a-z_]+)\.([A-Za-z0-9_]+):(.+)$/.exec(key);
    return m ? { point: m[1], question: m[2], subject: m[3] } : null;
}
export function calibrate(events, budgetPerDay) {
    const readings = new Map();
    let first = Infinity;
    let last = 0;
    for (const e of events) {
        if (e.kind !== "jev" || !e.answers)
            continue;
        readings.set(`${e.point}|${e.subject}`, e.answers);
        first = Math.min(first, Date.parse(e.ts));
        last = Math.max(last, Date.parse(e.ts));
    }
    const days = Math.max(1, (last - first) / 86_400_000);
    const verdicts = new Map();
    for (const e of events)
        if (e.kind === "ack")
            verdicts.set(e.incident, e.verdict);
    // Per question: every reading that flagged it, with its confidence and mark.
    const byKey = new Map();
    for (const e of events) {
        if (e.kind !== "incident")
            continue;
        const k = parseKey(e.key);
        if (!k)
            continue;
        const answer = readings.get(`${k.point}|${k.subject}`)?.[k.question];
        if (!answer)
            continue;
        const key = `${k.point}.${k.question}`;
        byKey.set(key, [...(byKey.get(key) ?? []), { confidence: answer.confidence, verdict: verdicts.get(e.incident) }]);
    }
    const out = [];
    for (const [key, all] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
        const marked = all.filter((r) => r.verdict === "useful" || r.verdict === "noise");
        const useful = marked.filter((r) => r.verdict === "useful");
        const noise = marked.filter((r) => r.verdict === "noise");
        const mean = (xs) => xs.reduce((s, r) => s + r.confidence, 0) / xs.length;
        const separation = useful.length && noise.length ? mean(useful) - mean(noise) : null;
        let threshold = null;
        let reason = null;
        if (marked.length < calibration.minMarks) {
            reason = `needs ${calibration.minMarks - marked.length} more mark(s)`;
        }
        else if (noise.length < calibration.minNoise) {
            reason = `needs ${calibration.minNoise - noise.length} more noise mark(s) to tell readings apart`;
        }
        else {
            const candidates = [...new Set(marked.map((r) => r.confidence))].filter((c) => c >= 0.5).sort((a, b) => a - b);
            for (const t of candidates) {
                const above = marked.filter((r) => r.confidence >= t);
                const usefulAbove = above.filter((r) => r.verdict === "useful").length;
                if (usefulAbove < calibration.minUsefulAbove)
                    break;
                const precise = usefulAbove / above.length >= calibration.precision;
                const perDay = all.filter((r) => r.confidence >= t).length / days;
                if (precise && perDay <= budgetPerDay) {
                    threshold = t;
                    break;
                }
            }
            if (threshold === null)
                reason = `no threshold reaches ${Math.round(calibration.precision * 100)}% useful within ${budgetPerDay}/day`;
        }
        out.push({ key, useful: useful.length, noise: noise.length, separation, threshold, reason });
    }
    return out;
}
