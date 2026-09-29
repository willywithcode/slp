import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter } from "node:path";
import { SlpError } from "./core/errors.js";
import { isShimDir } from "./permissions.js";
/** slp's own git (and commands it runs for a seat) never go through a seat's shim (a seat's `slp accept` merges for it). */
export function gitEnv() {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const path = (process.env[key] ?? "").split(delimiter).filter((entry) => !isShimDir(entry)).join(delimiter);
    return { ...process.env, [key]: path };
}
/** Run git in `cwd`. Never throws for a non-zero exit; callers decide. */
export function git(cwd, args) {
    return new Promise((resolve) => {
        execFile("git", [...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: gitEnv() }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
        });
    });
}
/** Run git and return trimmed stdout, or throw with git's own message. */
export async function gitOk(cwd, args) {
    const r = await git(cwd, args);
    if (r.code !== 0)
        throw new SlpError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
}
export async function toplevel(cwd) {
    const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return r.code === 0 ? r.stdout.trim() : null;
}
export async function currentBranch(cwd) {
    const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
}
export async function head(cwd, ref = "HEAD") {
    return gitOk(cwd, ["rev-parse", ref]);
}
/** `git status --porcelain` lines ("XY path"), with or without untracked files. */
export async function statusLines(cwd, untracked = true) {
    // Not trimmed as a whole: the first line's leading status column matters ("XY path").
    const r = await git(cwd, ["status", "--porcelain", `--untracked-files=${untracked ? "all" : "no"}`]);
    if (r.code !== 0)
        throw new SlpError(`git status failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.split(/\r?\n/).filter((l) => l.length > 3).map((l) => l.trimEnd());
}
/** Uncommitted changes (tracked or untracked), as porcelain paths. */
export async function dirtyPaths(cwd) {
    return (await statusLines(cwd)).map((l) => l.slice(3).trim());
}
export async function branchExists(cwd, branch) {
    return (await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}
/** Worktrees and the branch each has checked out. */
export async function worktrees(repo) {
    const out = await gitOk(repo, ["worktree", "list", "--porcelain"]);
    const list = [];
    for (const block of out.split(/\n\s*\n/)) {
        const path = /^worktree (.+)$/m.exec(block)?.[1];
        if (!path)
            continue;
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
        list.push({ path, branch });
    }
    return list;
}
export async function addWorktree(repo, path, branch, from) {
    await gitOk(repo, ["worktree", "add", "-b", branch, path, from]);
}
/** Uncommitted changes to tracked files only: what a working copy would lose if removed. */
export async function trackedChanges(cwd) {
    return (await statusLines(cwd, false)).map((l) => l.slice(3).trim());
}
/**
 * Remove a worktree slp made, as seatworks does: detached first (so its
 * branch is free), removed by git, then its folder deleted if git left it.
 * Kept only while tracked files hold uncommitted work; untracked files
 * (tool caches, Library, .utmp) do not keep it. Returns why it was kept, or
 * null when it is gone (already gone counts). `force` (the Human's
 * `slp clean --force`) discards even tracked changes.
 */
export async function removeWorktree(repo, path, force = false) {
    if (existsSync(path)) {
        const tracked = force ? [] : await trackedChanges(path).catch(() => null);
        if (tracked === null) {
            // Not a readable worktree any more: only its folder is left.
        }
        else if (tracked.length) {
            return `uncommitted changes to ${tracked.length} tracked file(s): ${tracked.slice(0, 5).join(", ")}`;
        }
        else {
            await git(path, ["switch", "--detach"]);
            await git(repo, ["worktree", "remove", "--force", path]);
        }
        if (existsSync(path)) {
            try {
                await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            }
            catch (error) {
                await git(repo, ["worktree", "prune"]);
                return `its folder could not be deleted (${error.message.split("\n")[0]}); a program may hold a file open`;
            }
        }
    }
    await git(repo, ["worktree", "prune"]);
    return null;
}
/**
 * Ready a worktree for reuse: only when tracked files are clean; untracked
 * files git does not ignore are removed, ignored ones (build caches, Library)
 * kept, and it is detached so its branch is free. Returns why not, or null.
 */
export async function freeWorktree(path) {
    const tracked = await trackedChanges(path).catch(() => null);
    if (tracked === null)
        return "it is not a working copy";
    if (tracked.length)
        return "tracked files hold uncommitted changes";
    const cleaned = await git(path, ["clean", "-fd"]);
    const detached = cleaned.code === 0 ? await git(path, ["switch", "--detach"]) : cleaned;
    return detached.code === 0 ? null : (detached.stderr || detached.stdout).trim();
}
/** Merge `from` into the branch checked out at `cwd`; aborts and reports on conflict. */
export async function mergeInto(cwd, from, message) {
    const r = await git(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, from]);
    if (r.code === 0)
        return { ok: true };
    const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
    await git(cwd, ["merge", "--abort"]);
    return { ok: false, conflicts };
}
/** One commit on top of `parent` whose tree is `treeish`'s tree (a squash). */
export async function squashCommit(cwd, treeish, parent, message) {
    const tree = await gitOk(cwd, ["rev-parse", `${treeish}^{tree}`]);
    return gitOk(cwd, ["commit-tree", tree, "-p", parent, "-m", message]);
}
export async function changedFiles(cwd, from, to) {
    const out = await gitOk(cwd, ["diff", "--name-only", `${from}..${to}`]);
    return out ? out.split("\n").filter(Boolean) : [];
}
/** The repository's shared git directory (a worktree's commits are written there). */
export async function commonDir(cwd) {
    return gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}
export async function treeOf(cwd, ref) {
    return gitOk(cwd, ["rev-parse", `${ref}^{tree}`]);
}
