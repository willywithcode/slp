import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { matches, normalizePath } from "../globs.js";
function hash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 10);
}
function clip(text, max = 160) {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}
/** Commands that destroy work or history. */
const DESTRUCTIVE = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease)/i,
    /\bgit\s+clean\s+-[a-z]*[fdx]/i,
    /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
    /\bgit\s+branch\s+-D\b/i,
    /\bgit\s+(filter-branch|filter-repo)\b/i,
    /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|\bRemove-Item\b[^\n]*-Force[^\n]*-Recurse/i,
    /\b(rd|rmdir)\s+\/s\b/i,
    /\bdel\s+\/[sq]\b/i,
    /\bdrop\s+(table|database|schema)\b/i,
    /\btruncate\s+table\b/i,
];
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;
const ASSERTION = /\b(expect|assert\w*|should|t\.(Error|Fatal)\w*|require\.\w+)\b/;
const SKIP = /\.(skip|only|todo)\(|\b(xit|xdescribe|xtest)\(|@pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]|@Disabled\b|@Ignore\b/;
const SUPPRESS = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|#\s*type:\s*ignore|#\s*noqa|#!?\[allow\(|@SuppressWarnings|\bas any\b|--no-verify|pylint:\s*disable|nolint/;
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)(\.cmd)?\s+(run\s+)?test\b|\bnode\s+--test\b|\b(vitest|jest|mocha|pytest|tox|nox)\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\b(mvn|mvnw|gradle|gradlew)\b[^\n]*\btest\b|\bmake\s+(test|check)\b|\bdotnet\s+test\b|\bslp(\.cmd)?\s+test\b/i;
/** Claude Code and Codex messages when an account runs out. */
const USAGE_LIMIT = /hit your (usage )?limit|usage limit reached|limit reached[^\n]*resets|rate[_ ]limit(_error| exceeded)|quota exceeded|insufficient_quota/i;
const AUTH_FAILED = /please run \/login|login expired|oauth access token is invalid|not logged in|authentication_failed|401 unauthorized/i;
export function isTestCommand(command) {
    return TEST_COMMAND.test(command);
}
/** A file an edit touched, relative to the working copy, or null when outside it. */
function inCopy(file, workdir) {
    const rel = normalizePath(isAbsolute(file) ? relative(workdir, file) : file);
    return rel.startsWith("../") || rel === ".." || isAbsolute(rel) ? null : rel;
}
/** Facts about individual steps (commands, edits, errors). */
export function stepFacts(steps, ctx) {
    const facts = [];
    for (const s of steps) {
        if (s.kind === "command") {
            if (DESTRUCTIVE.some((re) => re.test(s.text))) {
                facts.push({ fact: "destructive", level: "page", key: `destructive:${s.at}:${hash(s.text)}`, text: `ran a destructive command: ${clip(s.text)}` });
            }
            if (/--no-verify\b/.test(s.text)) {
                facts.push({ fact: "suppression", level: "attend", key: `no-verify:${s.at}:${hash(s.text)}`, text: `skipped hooks: ${clip(s.text)}` });
            }
        }
        if (s.kind === "edit") {
            const files = (s.files ?? []).map((f) => inCopy(f, ctx.workdir)).filter((f) => f !== null);
            const removed = s.removed ?? [];
            const added = s.added ?? [];
            const tests = files.filter((f) => TEST_FILE.test(f));
            if (tests.length) {
                const lostAsserts = removed.filter((l) => ASSERTION.test(l)).length - added.filter((l) => ASSERTION.test(l)).length;
                const skipped = added.filter((l) => SKIP.test(l) && !removed.some((r) => r.trim() === l.trim()));
                if (lostAsserts > 0 || skipped.length) {
                    const why = skipped.length ? `skipped or focused tests (${clip(skipped[0], 80)})` : `removed ${lostAsserts} assertion(s)`;
                    facts.push({ fact: "test_weakened", level: "attend", key: `test_weakened:${s.at}:${hash(s.text)}`, text: `${why} in ${tests.join(", ")}` });
                }
            }
            const suppressed = added.filter((l) => SUPPRESS.test(l) && !removed.some((r) => r.trim() === l.trim()));
            if (suppressed.length) {
                facts.push({ fact: "suppression", level: "attend", key: `suppression:${s.at}:${hash(s.text)}`, text: `added a suppression in ${files.join(", ") || "a file"}: ${clip(suppressed[0], 100)}` });
            }
            if (ctx.owned) {
                const outside = files.filter((f) => !matches(ctx.owned, f));
                if (outside.length) {
                    facts.push({ fact: "outside_owned", level: "attend", key: `outside_owned:${outside.sort().join(",")}`, text: `edited outside its owned paths (${ctx.owned.join(", ")}): ${outside.join(", ")}` });
                }
            }
        }
        // Only the agent's own API errors: a tool's output may mention limits of something else.
        if (s.kind === "error") {
            if (USAGE_LIMIT.test(s.text)) {
                facts.push({ fact: "usage_limit", level: "attend", key: `usage_limit:${s.at}`, text: `its account hit a usage limit: ${clip(s.text, 200)}` });
            }
            else if (AUTH_FAILED.test(s.text)) {
                facts.push({ fact: "auth_failed", level: "attend", key: `auth_failed:${s.at}`, text: `its account is not logged in: ${clip(s.text, 200)}` });
            }
        }
    }
    return facts;
}
/** The same command run again and again (at least 3 of the last 6). */
export function stuckFact(steps) {
    const commands = steps.filter((s) => s.kind === "command").slice(-6);
    const counts = new Map();
    for (const c of commands)
        counts.set(c.text.trim(), (counts.get(c.text.trim()) ?? 0) + 1);
    for (const [command, n] of counts) {
        if (n >= 3) {
            const last = commands.filter((c) => c.text.trim() === command).at(-1);
            return { fact: "stuck", level: "attend", key: `stuck:${hash(command)}:${last.at}`, text: `repeats the same command (${n} of its last ${commands.length}): ${clip(command, 120)}` };
        }
    }
    return null;
}
/** A "complete" hand-back with edits after the last test run. */
export function unverifiedFact(steps, task) {
    const lastEdit = steps.findLastIndex((s) => s.kind === "edit");
    if (lastEdit < 0)
        return null;
    const lastTest = steps.findLastIndex((s) => s.kind === "command" && isTestCommand(s.text));
    if (lastTest > lastEdit)
        return null;
    return {
        fact: "unverified", level: "attend", key: `unverified:${task}:${steps[lastEdit].at}`,
        text: lastTest < 0 ? `handed back ${task} as complete without running tests` : `handed back ${task} as complete; files changed after its last test run`,
    };
}
/** Screens: the agents' own words when an account is out, as shown in the pane. */
export function screenFact(screen) {
    const bottom = screen.split(/\r?\n/).filter((l) => l.trim()).slice(-12).join("\n");
    if (USAGE_LIMIT.test(bottom))
        return { fact: "usage_limit", level: "attend", key: `usage_limit:screen:${hash(bottom)}`, text: `its pane shows a usage limit: ${clip(bottom.split("\n").find((l) => USAGE_LIMIT.test(l)) ?? "", 200)}` };
    if (AUTH_FAILED.test(bottom))
        return { fact: "auth_failed", level: "attend", key: `auth_failed:screen:${hash(bottom)}`, text: "its pane asks for a login" };
    return null;
}
