import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGate } from "./gate.js";
import { git, gitEnv } from "./git.js";
import { overlaps } from "./globs.js";
// Making a new working copy ready before its seat starts (ADR 0019), as
// seatworks does: the git-ignored files `.worktreeinclude` names, then the
// config's `lanes.setup` command. And a warning when a write set reaches
// into a submodule.
const files = (stdout) => stdout.split("\0").filter(Boolean);
/**
 * Copy into `copy` the files git ignores that the project's
 * `.worktreeinclude` names (as Claude Code, Codex and Conductor read it): a
 * copy made from git never has them. Returns how many, or why it could not.
 */
export async function bringIncluded(root, copy) {
    const named = join(root, ".worktreeinclude");
    if (!existsSync(named))
        return null;
    const untracked = (exclude) => git(root, ["ls-files", "-z", "--others", "--ignored", exclude]);
    const [ignored, included] = await Promise.all([untracked("--exclude-standard"), untracked(`--exclude-from=${named}`)]);
    if (ignored.code !== 0 || included.code !== 0)
        return { failed: "git could not list the files .worktreeinclude names" };
    const wanted = new Set(files(included.stdout));
    let copied = 0;
    try {
        for (const file of files(ignored.stdout).filter((path) => wanted.has(path))) {
            await mkdir(dirname(join(copy, file)), { recursive: true });
            await copyFile(join(root, file), join(copy, file));
            copied += 1;
        }
    }
    catch (error) {
        return { failed: `a file .worktreeinclude names could not be copied: ${error.message}` };
    }
    return { copied };
}
/** Submodule paths the repository declares. */
export async function submodules(root) {
    if (!existsSync(join(root, ".gitmodules")))
        return [];
    const r = await git(root, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
    return r.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.split(" ").slice(1).join(" ").trim()).filter(Boolean) : [];
}
/** Why a write set reaching into a submodule does not land as one expects, or null. */
export async function submoduleWarning(root, writeSet) {
    const inside = (await submodules(root)).filter((path) => overlaps(writeSet, [`${path}/**`]));
    if (!inside.length)
        return null;
    return `The write set reaches into submodule(s) ${inside.join(", ")}. Commits there belong to the submodule's own repository: ` +
        "they do not land with this repository's squash (only a changed submodule pointer would), and slp does not push them. " +
        "Settle with the Human how that work is published, or keep the lane out of the submodule.";
}
/**
 * Make a new copy ready: `.worktreeinclude` files, then `lanes.setup`. The
 * result is for whoever directs the work there (its Lead).
 */
export async function prepareCopy(root, copy, config, timeoutMs) {
    const notes = [];
    const included = await bringIncluded(root, copy);
    if (included && "failed" in included)
        notes.push(`.worktreeinclude: ${included.failed}.`);
    else if (included)
        notes.push(`.worktreeinclude: ${included.copied} git-ignored file(s) copied in.`);
    const setup = config.lanes.setup;
    if (setup) {
        const run = await runGate(setup, copy, timeoutMs, gitEnv());
        const secs = Math.round(run.durationMs / 1000);
        notes.push(run.ok ? `Setup \`${setup}\` ran in the new copy (${secs}s).`
            : `Setup \`${setup}\` FAILED in the new copy (${secs}s); the copy may be incomplete:\n${run.tail}`);
    }
    else if ((await submodules(root)).length) {
        notes.push("This repository has submodules, which a new copy does not check out; the Human can set " +
            "`\"lanes\": { \"setup\": \"git submodule update --init --recursive\" }` in the slp config.");
    }
    return notes;
}
