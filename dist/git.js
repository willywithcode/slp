import { execFile } from "node:child_process";
import { SlpError } from "./core/errors.js";
/** Run git in `cwd`. Never throws for a non-zero exit; callers decide. */
export function git(cwd, args) {
    return new Promise((resolve) => {
        execFile("git", [...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
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
/** Uncommitted changes (tracked or untracked), as porcelain paths. */
export async function dirtyPaths(cwd) {
    const out = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"]);
    return out ? out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
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
/**
 * Remove a worktree slp made, only if it holds no uncommitted work (git
 * refuses otherwise). Returns false when it was kept. A worktree already
 * gone counts as removed.
 */
export async function removeWorktree(repo, path) {
    const r = await git(repo, ["worktree", "remove", path]);
    await git(repo, ["worktree", "prune"]);
    if (r.code === 0)
        return true;
    return !(await worktrees(repo)).some((w) => samePath(w.path, path));
}
function samePath(a, b) {
    const norm = (p) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
    return norm(a) === norm(b);
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
