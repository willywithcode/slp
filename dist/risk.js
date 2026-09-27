import { git } from "./git.js";
// Code fallbacks for the catalogue's risk questions (6 lane_risk, 16
// data_loss_risk, 12 needs_review): plain rules that hold a landing for the
// Human rather than guess (ADR 0013).
const RISKY_WORDS = /\b(auth\w*|login|password|credential\w*|token|secret\w*|payment\w*|billing|invoice\w*|migrat\w*|schema|database|security|crypto\w*|encrypt\w*|permission\w*|delete|drop)\b/i;
const RISKY_PATHS = /(^|\/)(migrations?|schema|auth|payments?|billing|security|secrets?)(\/|\.|$)/i;
/** A lane whose words or write set touch sensitive ground (catalogue 6). */
export function laneRisky(lane) {
    const words = RISKY_WORDS.exec(`${lane.title} ${lane.outcome}`)?.[0];
    if (words)
        return `its outcome mentions "${words}"`;
    const path = lane.writeSet.find((g) => RISKY_PATHS.test(g));
    return path ? `its write set covers ${path}` : null;
}
/**
 * Whether the lane's work up to `upTo` had a review of the whole lane: a
 * finished lane review of exactly that commit, or one followed only by slp's
 * own merges of the base branch.
 */
export async function laneReviewed(root, state, lane, upTo) {
    for (const r of state.reviews.values()) {
        if (r.lane !== lane.id || r.target !== lane.id || !r.done || r.done.summary.startsWith("not run") || !r.head)
            continue;
        if (r.head === upTo)
            return true;
        if ((await git(root, ["merge-base", "--is-ancestor", r.head, upTo])).code !== 0)
            continue;
        const since = (await git(root, ["log", "--format=%s", `${r.head}..${upTo}`])).stdout.split("\n").filter(Boolean);
        if (since.every((subject) => subject === `Merge ${lane.base} into ${lane.branch}`))
            return true;
    }
    return false;
}
/** SQL that removes stored data: drops, truncates, and deletes without a WHERE. */
const DESTRUCTIVE_SQL = [
    /\bdrop\s+(table|column|database|schema|index)\b/i,
    /\btruncate\s+(table\s+)?\w+/i,
    /\balter\s+table\s+\S+\s+drop\b/i,
    /\bdelete\s+from\s+[\w."`[\]]+\s*(;|$|["'`)])/i,
];
/**
 * What in a diff could lose stored data (catalogue 16): migrations and
 * destructive SQL. Deleted source files are not counted: git keeps them and
 * every landing is one revertible commit.
 */
export async function dataLossSigns(cwd, from, to) {
    const signs = [];
    const status = (await git(cwd, ["diff", "--name-status", `${from}..${to}`])).stdout.split("\n").filter(Boolean);
    const migrations = status.map((l) => l.split("\t").at(-1)).filter((p) => /(^|\/)migrations?\//i.test(p));
    if (migrations.length)
        signs.push(`it changes migrations: ${migrations.slice(0, 5).join(", ")}`);
    const added = (await git(cwd, ["diff", "-U0", `${from}..${to}`])).stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const sql = added.find((l) => DESTRUCTIVE_SQL.some((re) => re.test(l)));
    if (sql)
        signs.push(`it adds destructive SQL: ${sql.slice(1).trim().slice(0, 120)}`);
    return signs;
}
/** Lines changed between two commits (catalogue 12: a large change suggests a review). */
export async function changedLines(cwd, from, to) {
    const out = (await git(cwd, ["diff", "--numstat", `${from}..${to}`])).stdout;
    return out.split("\n").filter(Boolean).reduce((n, l) => {
        const [a, d] = l.split("\t");
        return n + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
}
