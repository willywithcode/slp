import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GoneError, SlpError } from "./core/errors.js";
import { append, readLedger } from "./core/ledger.js";
import { lockHeldByLiveProcess } from "./core/lock.js";
import { projectDir } from "./core/paths.js";
import { HerdrError } from "./herdr.js";
import { fold } from "./state.js";
/** Letters longer than this are stored in a file the target is pointed at (Windows command-line limit). */
export const INLINE_LIMIT = 6_000;
/** Submission checks; mutable only so tests need not wait. */
export const submitCheck = { waitMs: 3_000, pollMs: 250 };
const HINTS = {
    INTRO: "Run `slp guide` now.",
    DIRECTIVE: "This is your lane. Plan it, then brief Peers with `slp start-task` (see `slp guide`).",
    TASK: "When finished or blocked: `slp done` (see `slp guide`). Questions: `slp ask`.",
    REWORK: "Address this, then hand back again with `slp done`.",
    HANDBACK: "Decide with `slp accept`, `slp rework` or `slp cut` (see `slp guide`).",
    REVIEW: "Read only. Report with `slp done` and your findings (see `slp guide`).",
    FINDINGS: "Weigh the findings; decide with `slp accept`, `slp rework` or `slp cut`.",
    ASK: "Answer with `slp answer <ask> \"...\"`.",
    STILL_OPEN: "This ask is still open: answer it with `slp answer`.",
    REPORT: "Close the lane with `slp close-lane` when acceptance is met (see `slp guide`).",
    CRITIQUE: "Weigh these against the lane; amend it with `slp amend-lane` or note why not.",
};
export function envelope(l, body) {
    const where = [l.lane, l.task].filter(Boolean).join(" · ");
    const hint = HINTS[l.letter];
    return `[SLP ${l.letter} #${l.seq} from ${l.from}${where ? ` · ${where}` : ""}]\n\n${body}${hint ? `\n\n[SLP] ${hint}` : ""}`;
}
export function watchLockPath(env, project) {
    return join(projectDir(env, project), "watch.lock");
}
/** Record a letter and deliver it (or queue it for the watcher). */
export async function sendLetter(deps, project, draft) {
    const event = await append(deps.env, project, () => ({
        kind: "letter", letter: draft.letter, from: draft.from, to: draft.to, text: draft.text,
        lane: draft.lane ?? null, task: draft.task ?? null,
    }));
    return deliver(deps, project, event);
}
async function record(deps, project, ref, ok, error, stage, reason) {
    await append(deps.env, project, () => ({
        kind: "delivery", ref, ok, error, ...(stage ? { stage } : {}), ...(reason ? { reason } : {}),
    }));
}
/** A failure to reach Herdr at all, as opposed to Herdr refusing the prompt. */
export function unreachable(error) {
    return error instanceof HerdrError && error.code === "cli_failed";
}
export function describe(error) {
    if (error instanceof HerdrError)
        return `${error.code}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}
async function deliver(deps, project, letter) {
    const state = fold(await readLedger(deps.env, project));
    if (letter.to === "human") {
        await deps.herdr.notify(`slp: ${letter.letter} from ${letter.from}`, letter.text).catch(() => undefined);
        await record(deps, project, letter.seq, true, null);
        return { seq: letter.seq, status: "delivered" };
    }
    const target = state.seats.get(letter.to);
    if (!target || !target.live) {
        await record(deps, project, letter.seq, false, `no live seat "${letter.to}"`);
        throw new GoneError(`Letter #${letter.seq} was recorded, but "${letter.to}" has no live seat.`);
    }
    const watching = await lockHeldByLiveProcess(watchLockPath(deps.env, project));
    let status = null;
    try {
        status = await deps.herdr.agentStatus(target.paneId);
    }
    catch (error) {
        if (unreachable(error) && watching) {
            await record(deps, project, letter.seq, false, describe(error), "queued", "unreachable");
            deps.out(`${letter.letter} #${letter.seq} recorded; the watcher will deliver it within seconds. Nothing else to do.`);
            return { seq: letter.seq, status: "queued" };
        }
    }
    if (watching && (status === "working" || status === "blocked")) {
        await record(deps, project, letter.seq, false, null, "queued", "busy");
        deps.out(`${letter.letter} #${letter.seq} recorded; ${letter.to} is busy, the watcher delivers it when it is free.`);
        return { seq: letter.seq, status: "queued" };
    }
    try {
        await handToAgent(deps, target.paneId, await render(deps, project, letter));
    }
    catch (error) {
        const reason = describe(error);
        if (unreachable(error) && watching) {
            await record(deps, project, letter.seq, false, reason, "queued", "unreachable");
            deps.out(`${letter.letter} #${letter.seq} recorded; the watcher will deliver it within seconds. Nothing else to do.`);
            return { seq: letter.seq, status: "queued" };
        }
        await record(deps, project, letter.seq, false, reason);
        throw new SlpError(`${letter.letter} #${letter.seq} was recorded but NOT delivered to ${letter.to}: ${reason}. ` +
            (unreachable(error)
                ? "This terminal cannot reach Herdr and no watcher runs; start `slp start` (or `slp watch`) outside any sandbox."
                : `Fix the cause, then run \`slp redeliver ${letter.seq}\`.`));
    }
    await record(deps, project, letter.seq, true, null);
    deps.out(`${letter.letter} #${letter.seq} delivered to ${letter.to}`);
    return { seq: letter.seq, status: "delivered" };
}
async function render(deps, project, l) {
    let body = l.text;
    if (body.length > INLINE_LIMIT) {
        const dir = join(projectDir(deps.env, project), "letters");
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${l.seq}-${l.letter}.md`);
        await writeFile(file, l.text, "utf8");
        body = `The full letter is long; read it from this file before acting:\n${file}`;
    }
    return envelope(l, body);
}
class NotQueued extends Error {
}
/**
 * Deliver waiting letters: every queued letter whose target is not busy, all
 * letters for one seat in a single message. Claims each letter first
 * ("relaying", checked under the ledger lock), so an interrupted pump leaves
 * it unconfirmed rather than sending it twice.
 */
export async function pump(deps, project) {
    const state = fold(await readLedger(deps.env, project));
    const byTarget = new Map();
    for (const l of state.letters) {
        if (l.status !== "queued")
            continue;
        byTarget.set(l.to, [...(byTarget.get(l.to) ?? []), l]);
    }
    let delivered = 0;
    for (const [to, letters] of byTarget) {
        const target = state.seats.get(to);
        if (!target || !target.live)
            continue;
        const status = await deps.herdr.agentStatus(target.paneId).catch(() => null);
        if (status === "working" || status === "blocked")
            continue;
        const claimed = [];
        for (const l of letters) {
            const ok = await append(deps.env, project, (events) => {
                const last = events.findLast((e) => e.kind === "delivery" && e.ref === l.seq);
                if (!last || last.kind !== "delivery" || last.stage !== "queued")
                    throw new NotQueued();
                return { kind: "delivery", ref: l.seq, ok: false, error: "relaying", stage: "relaying" };
            }).then(() => true, (error) => {
                if (error instanceof NotQueued)
                    return false;
                throw error;
            });
            if (ok)
                claimed.push(l);
        }
        if (!claimed.length)
            continue;
        const parts = await Promise.all(claimed.map((l) => render(deps, project, l)));
        let error = null;
        try {
            await handToAgent(deps, target.paneId, parts.join("\n\n---\n\n"));
        }
        catch (e) {
            error = describe(e);
        }
        for (const l of claimed)
            await record(deps, project, l.seq, error === null, error);
        if (error === null)
            delivered += claimed.length;
        deps.out(error === null ? `delivered ${claimed.length} waiting letter(s) to ${to}` : `could not deliver waiting letters to ${to}: ${error}`);
    }
    return delivered;
}
/** A relay claim younger than this is in flight; an older one was interrupted. */
const RELAY_GRACE_MS = 60_000;
/**
 * Retry a letter. Herdr has no idempotent prompt, so only a delivery Herdr
 * refused is retried by default; a delivered or unconfirmed one needs `force`.
 * `seat` is the sender asking (a seat may only redeliver its own letters), or
 * null for the Human, who may redeliver any.
 */
export async function redeliver(deps, project, seat, seq, force) {
    const events = await readLedger(deps.env, project);
    const state = fold(events);
    const l = state.letters.find((x) => x.seq === seq);
    if (!l)
        throw new SlpError(`No letter #${seq}`);
    if (seat !== null && l.from !== seat)
        throw new SlpError(`Letter #${seq} was sent by ${l.from}; only its sender can redeliver it`);
    if (l.status === "relaying" && l.lastAttemptAt && (deps.now?.() ?? Date.now()) - Date.parse(l.lastAttemptAt) < RELAY_GRACE_MS) {
        throw new SlpError(`Letter #${seq} is being delivered by the watcher right now; check ${l.to}'s pane in a minute.`);
    }
    if (l.status === "queued")
        throw new SlpError(`Letter #${seq} is waiting for the watcher, which will deliver it.`);
    if (!force && l.status !== "failed") {
        throw new SlpError(l.status === "delivered"
            ? `Letter #${seq} was already delivered; use --force to send it again.`
            : `Letter #${seq}'s delivery is unconfirmed; it may already be in ${l.to}'s pane. Check, then use --force.`);
    }
    const event = events.find((e) => e.kind === "letter" && e.seq === seq);
    return deliver(deps, project, event);
}
/**
 * Prompt an agent and make sure the text was submitted, not left in its input
 * box (seen live with Claude Code and long prompts): if it does not start
 * working and its input line still shows unsent pasted text, press Enter once.
 */
export async function handToAgent(deps, paneId, text) {
    await deps.herdr.prompt(paneId, text);
    if (await startsWorking(deps, paneId))
        return;
    if (!(await holdsUnsentPaste(deps, paneId)))
        return;
    const status = await deps.herdr.agentStatus(paneId).catch(() => null);
    if (status !== "idle" && status !== "done")
        return; // never press Enter into a dialog
    await deps.herdr.sendKeys(paneId, ["enter"]);
    if (!(await startsWorking(deps, paneId)))
        deps.out(`  warning: ${paneId} may still hold the message unsent in its input box`);
}
async function holdsUnsentPaste(deps, paneId) {
    const screen = await deps.herdr.agentRead(paneId).catch(() => "");
    const bottom = screen.split(/\r?\n/).filter((line) => line.trim()).slice(-4);
    return bottom.some((line) => /\[Pasted text/i.test(line));
}
async function startsWorking(deps, paneId) {
    const deadline = Date.now() + submitCheck.waitMs;
    for (;;) {
        const status = await deps.herdr.agentStatus(paneId).catch(() => null);
        if (status === "working" || status === "blocked")
            return true;
        if (Date.now() >= deadline)
            return false;
        await new Promise((resolve) => setTimeout(resolve, submitCheck.pollMs));
    }
}
