import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { SlpError } from "./errors.js";
/** Lock timing; mutable only so tests can shorten waits. */
export const lockTiming = {
    retryMs: 25,
    timeoutMs: 10_000,
    /** A lock without an owner file (holder died between mkdir and write). */
    ownerlessStaleMs: 30_000,
    /** A lock owned by another host, whose pid cannot be checked. */
    foreignStaleMs: 5 * 60_000,
};
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
            throw new SlpError(opts.busy?.(owner) ??
                `Timed out waiting for lock ${lock}` + (owner ? ` (held by pid ${owner.pid} on ${owner.host})` : ""));
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
        return; // directory gone, or leave it for reclamation
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
