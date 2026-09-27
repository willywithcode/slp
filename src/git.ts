import { execFile } from "node:child_process";
import { SlpError } from "./core/errors.js";

// Git operations for lanes (ADR 0008). Seats never run these; slp does, on
// behalf of the Lead and Supervisor, and never pushes.

export interface GitResult { code: number; stdout: string; stderr: string }

/** Run git in `cwd`. Never throws for a non-zero exit; callers decide. */
export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
    });
  });
}

/** Run git and return trimmed stdout, or throw with git's own message. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new SlpError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function toplevel(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function head(cwd: string, ref = "HEAD"): Promise<string> {
  return gitOk(cwd, ["rev-parse", ref]);
}

/** Uncommitted changes (tracked or untracked), as porcelain paths. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return out ? out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** Worktrees and the branch each has checked out. */
export async function worktrees(repo: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await gitOk(repo, ["worktree", "list", "--porcelain"]);
  const list: { path: string; branch: string | null }[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    list.push({ path, branch });
  }
  return list;
}

export async function addWorktree(repo: string, path: string, branch: string, from: string): Promise<void> {
  await gitOk(repo, ["worktree", "add", "-b", branch, path, from]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
  await git(repo, ["worktree", "prune"]);
}

/** Merge `from` into the branch checked out at `cwd`; aborts and reports on conflict. */
export async function mergeInto(cwd: string, from: string, message: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  const r = await git(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, from]);
  if (r.code === 0) return { ok: true };
  const conflicts = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
  await git(cwd, ["merge", "--abort"]);
  return { ok: false, conflicts };
}

/** One commit on top of `parent` whose tree is `treeish`'s tree (a squash). */
export async function squashCommit(cwd: string, treeish: string, parent: string, message: string): Promise<string> {
  const tree = await gitOk(cwd, ["rev-parse", `${treeish}^{tree}`]);
  return gitOk(cwd, ["commit-tree", tree, "-p", parent, "-m", message]);
}

export async function changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await gitOk(cwd, ["diff", "--name-only", `${from}..${to}`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The repository's shared git directory (a worktree's commits are written there). */
export async function commonDir(cwd: string): Promise<string> {
  return gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export async function treeOf(cwd: string, ref: string): Promise<string> {
  return gitOk(cwd, ["rev-parse", `${ref}^{tree}`]);
}
