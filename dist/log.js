import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadRoom, RoomGoneError, roomDir, SplError } from "./room.js";
const base = { seq: z.number().int().positive(), ts: z.string() };
const message = { ...base, case: z.string(), from: z.string(), to: z.string(), text: z.string() };
export const EventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("brief"), ...message }),
    z.object({ kind: z.literal("handback"), ...message }),
    // `closes`: the Lead accepted and closed the case; the recipient owes nothing.
    z.object({ kind: z.literal("reply"), ...message, closes: z.literal(true).optional() }),
    // Outcome of handing a message event (`ref`) to Herdr. A message event
    // without a successful delivery was recorded but never reached its target.
    z.object({
        kind: z.literal("delivery"), ...base, ref: z.number().int().positive(), ok: z.boolean(), error: z.string().nullable(),
        // Alerts only: which channel this attempt used.
        channel: z.enum(["prompt", "notification"]).optional(),
        // Messages only. "queued": the sender could not reach Herdr (e.g. an agent
        // sandbox) and left it for the room watcher; "relaying": the watcher
        // claimed it and is delivering it now.
        stage: z.enum(["queued", "relaying"]).optional(),
    }),
    // Raised by `spl watch`. `key` identifies the trigger so it fires once.
    z.object({
        kind: z.literal("alert"), ...base, key: z.string(), rule: z.string(),
        case: z.string().nullable(), member: z.string().nullable(), text: z.string(),
    }),
    // A Jev judgment of a case's communication up to message `upTo` (ADR 0005:
    // only with --jev). `answers` is null when the request failed.
    z.object({
        kind: z.literal("assessment"), ...base, case: z.string(), upTo: z.number().int().positive(),
        mode: z.enum(["shadow", "alert"]), verdict: z.enum(["handled", "drift", "unknown"]),
        answers: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number() })).nullable(),
    }),
]);
export const isMessage = (e) => e.kind === "brief" || e.kind === "handback" || e.kind === "reply";
/** Lock timing; mutable only so tests can shorten waits. */
export const lockTiming = {
    retryMs: 25,
    timeoutMs: 10_000,
    /** A lock without an owner file (holder died between mkdir and write). */
    ownerlessStaleMs: 30_000,
    /** A lock owned by another host, whose pid cannot be checked. */
    foreignStaleMs: 5 * 60_000,
};
export function eventsPath(env, room) {
    return join(roomDir(env, room), "events.jsonl");
}
export async function readEvents(env, room) {
    return parseEvents(await readRaw(eventsPath(env, room)));
}
async function readRaw(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "";
        throw error;
    }
}
function parseEvents(raw) {
    const events = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        // A torn line (crash mid-append) is skipped rather than fatal.
        const parsed = EventSchema.safeParse(safeJson(line));
        if (parsed.success)
            events.push(parsed.data);
    }
    return events;
}
function safeJson(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
/**
 * Append one event under an exclusive room lock. `build` sees the current
 * events, so validation and sequence/case numbering are race-free across
 * the several agent processes that share a room. With `expect`, the room on
 * disk must still be that instance (same workspace and creation time), checked
 * under the lock, so a writer holding an archived room never writes into a
 * newer room that reused the name.
 */
export async function appendEvent(env, room, build, expect) {
    const dir = roomDir(env, room);
    // Never recreate a room: after `spl down` archived it, a late writer (e.g. a
    // watcher still running) must fail rather than start a new, split log.
    const gone = () => new RoomGoneError(`Room "${room}" does not exist (it may have been archived by \`spl down\`)`);
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false)))
        throw gone();
    const lock = join(dir, "events.lock");
    const token = await acquireLock(lock).catch((error) => {
        throw error.code === "ENOENT" ? gone() : error;
    });
    try {
        if (expect) {
            const current = await loadRoom(env, room);
            if (!current)
                throw gone();
            if (current.workspaceId !== expect.workspaceId || current.createdAt !== expect.createdAt) {
                throw new RoomGoneError(`Room "${room}" was replaced by a newer room with the same name`);
            }
        }
        const path = eventsPath(env, room);
        const raw = await readRaw(path);
        const events = parseEvents(raw);
        const draft = build(events);
        const seq = (events.at(-1)?.seq ?? 0) + 1;
        const event = EventSchema.parse({ ...draft, seq, ts: new Date().toISOString() });
        // Terminate a torn tail so it cannot swallow this event.
        const separator = raw && !raw.endsWith("\n") ? "\n" : "";
        await appendFile(path, `${separator}${JSON.stringify(event)}\n`, "utf8");
        return event;
    }
    finally {
        await releaseLock(lock, token);
    }
}
/**
 * Take a directory lock and return its token. mkdir is atomic on every
 * supported platform. The holder records itself in the lock; a lock is only
 * taken over when its holder is provably gone, never because it is old, and
 * takeovers and releases are serialized by a guard so a fresh lock is never
 * mistaken for the stale one it replaced.
 */
export async function acquireLock(lock, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? lockTiming.timeoutMs);
    for (;;) {
        const token = await claim(lock);
        if (token)
            return token;
        // Retry at once only if the stale lock was actually removed; otherwise
        // wait like any other contender, bounded by the deadline.
        if (await isStale(lock, opts.reclaimForeign) && await reclaim(lock, opts.reclaimForeign))
            continue;
        if (Date.now() >= deadline) {
            const owner = await readOwner(lock);
            throw new SplError(opts.busy?.(owner) ??
                `Timed out waiting for room lock ${lock}` + (owner ? ` (held by pid ${owner.pid} on ${owner.host})` : ""));
        }
        await new Promise((resolve) => setTimeout(resolve, lockTiming.retryMs));
    }
}
/**
 * Release a lock this process holds. The lock is only removed while holding
 * the reclaim guard, so a concurrent takeover cannot swap it underneath. If
 * the guard stays busy, the lock is left in place: it becomes reclaimable as
 * soon as this process exits, which is safer than removing it unguarded.
 */
export async function releaseLock(lock, token) {
    const guard = await takeGuard(`${lock}.reclaim`, 5_000);
    if (guard === "gone" || guard === "busy")
        return; // room archived, or leave it for reclamation
    try {
        await removeOwned(lock, token);
    }
    finally {
        await removeOwned(`${lock}.reclaim`, guard.token);
    }
}
/** mkdir + owner record. Returns the token, or null if the directory exists. */
async function claim(dir) {
    try {
        await mkdir(dir);
    }
    catch (error) {
        if (error.code === "EEXIST")
            return null;
        throw error;
    }
    const owner = { token: randomUUID(), pid: process.pid, host: hostname(), at: Date.now() };
    await writeFile(join(dir, "owner.json"), JSON.stringify(owner), "utf8");
    return owner.token;
}
async function removeOwned(dir, token) {
    if ((await readOwner(dir))?.token === token)
        await rm(dir, { recursive: true, force: true });
}
/**
 * Take the reclaim guard, waiting up to `waitMs`. A guard whose owner is gone
 * (same rule as for locks) is cleared. Residual risk, accepted and documented:
 * two processes clearing the same dead guard at the same instant could both
 * proceed; this needs a process to die inside a millisecond-long guarded step.
 */
async function takeGuard(guard, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        let token;
        try {
            token = await claim(guard);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return "gone";
            throw error;
        }
        if (token)
            return { token };
        if (await isStale(guard))
            await rm(guard, { recursive: true, force: true });
        else if (Date.now() >= deadline)
            return "busy";
        else
            await new Promise((resolve) => setTimeout(resolve, lockTiming.retryMs));
    }
}
/**
 * `reclaimForeign` false: a lock owned by another host is never stale, since
 * its owner's liveness cannot be checked (long-held locks such as a watcher's).
 */
async function isStale(lock, reclaimForeign = true) {
    const owner = await readOwner(lock);
    if (!owner)
        return (await ageOf(lock)) > lockTiming.ownerlessStaleMs;
    if (owner.host !== hostname())
        return reclaimForeign && Date.now() - owner.at > lockTiming.foreignStaleMs;
    return !isAlive(owner.pid);
}
/** Whether a lock exists and its owner is alive (by the same rule as takeovers). */
export async function lockHeldByLiveProcess(lock) {
    return (await readOwner(lock)) !== null && !(await isStale(lock, false));
}
/** Remove a stale lock under the guard. Returns whether it was removed. */
async function reclaim(lock, reclaimForeign = true) {
    const guard = await takeGuard(`${lock}.reclaim`, 0);
    if (guard === "busy")
        return false; // someone else is reclaiming or releasing
    if (guard === "gone")
        throw Object.assign(new Error(`${lock} no longer exists`), { code: "ENOENT" });
    try {
        // Re-check under the guard: another reclaimer may already have replaced it.
        if (!(await isStale(lock, reclaimForeign)))
            return false;
        await rm(lock, { recursive: true, force: true });
        return true;
    }
    finally {
        await removeOwned(`${lock}.reclaim`, guard.token);
    }
}
async function readOwner(lock) {
    try {
        const value = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
        return typeof value.token === "string" && typeof value.pid === "number" && typeof value.host === "string" && typeof value.at === "number"
            ? value : null;
    }
    catch {
        return null;
    }
}
async function ageOf(path) {
    return stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return error.code === "EPERM";
    }
}
export function nextCaseId(events) {
    return `c${events.filter((e) => e.kind === "brief").length + 1}`;
}
