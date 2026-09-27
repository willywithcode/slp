import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { slpHome } from "./core/paths.js";
import { writeAtomic } from "./core/fsutil.js";
// Seat permissions (ADR 0016), after seatworks: seats run without asking
// where a sandbox holds them, each role is denied what it must never do, and
// a git shim on every seat's PATH refuses the git commands a role must not
// run. Where no sandbox exists (Claude Code on Windows), seats keep asking,
// with read and test commands allowed.
/** Git subcommands no seat runs: branches and working copies are slp's. */
const GIT_NEVER = ["push", "pull", "checkout", "switch", "update-ref", "stash"];
/** Git subcommands that move a branch: only a Peer, on its own branch. */
const GIT_MOVES = ["commit", "merge", "reset", "rebase", "cherry-pick"];
/** Git subcommands that change files: never for a reader. */
const GIT_CHANGES = ["add", "rm", "mv", "restore", "revert", "clean", "apply", "am", "config"];
export function gitDenied(role) {
    if (role === "peer")
        return GIT_NEVER;
    if (role === "reviewer" || role === "critic")
        return [...GIT_NEVER, ...GIT_MOVES, ...GIT_CHANGES];
    return [...GIT_NEVER, ...GIT_MOVES];
}
function bashDeny(subcommands) {
    return subcommands.flatMap((s) => [`Bash(git ${s} *)`, `Bash(git -C * ${s} *)`]);
}
/** Tools and paths no seat touches: subagents, other agents' logins and secrets, git config. */
const SEAT_DENY = [
    "Agent", "Workflow", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "ScheduleWakeup", "SendMessage",
    "Read(~/.claude/.credentials.json)", "Edit(~/.claude/**)", "Read(~/.codex/auth.json)", "Read(~/.codex-*/auth.json)",
    "Edit(~/.codex/**)", "Edit(~/.codex-*/**)", "Read(~/.secrets/**)", "Edit(~/.secrets/**)", "Edit(~/.slp/**)",
    "Edit(~/.gitconfig)", "Edit(~/.config/git/**)",
    "Bash(git branch -f *)", "Bash(git branch -D *)", "Bash(git branch --force *)",
];
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
/** Commands a reading seat may run without asking where it cannot be sandboxed. */
const READ_AND_TEST = [
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
    "Bash(npm test*)", "Bash(npm run test*)", "Bash(node --test*)", "Bash(pnpm test*)", "Bash(yarn test*)",
    "Bash(pytest*)", "Bash(go test*)", "Bash(cargo test*)",
];
/**
 * Claude Code settings for a role. `sandboxed`: the platform has Claude
 * Code's sandbox (not Windows today): seats then run without asking, held by
 * the sandbox, like seatworks; otherwise they ask for anything not allowed.
 */
export function claudeSettings(role, sandboxed, home) {
    const deny = [...SEAT_DENY, ...bashDeny(gitDenied(role))];
    if (role !== "peer")
        deny.push(...WRITE_TOOLS, "Bash(sleep *)");
    const allow = ["Bash(slp *)", "Bash(slp.cmd *)", ...(role === "peer" ? [] : READ_AND_TEST)];
    if (!sandboxed)
        return { permissions: { allow, deny } };
    return {
        permissions: { defaultMode: "bypassPermissions", allow, deny },
        // The seat's `slp` writes the team's ledger under slp's home.
        sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true }, filesystem: { allowWrite: [home] } },
        skipDangerousModePermissionPrompt: true,
    };
}
/** Claude Code's sandbox exists on macOS and Linux, not (yet) on Windows. */
export function claudeSandboxed(platform = process.platform) {
    return platform !== "win32";
}
/** Write the role's settings file and return its path. */
export async function writeClaudeSettings(env, role, platform = process.platform) {
    const dir = join(slpHome(env), "settings");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `claude-${role}.json`);
    await writeAtomic(path, `${JSON.stringify(claudeSettings(role, claudeSandboxed(platform), slpHome(env)), null, 2)}\n`);
    return path;
}
// ------------------------------------------------------------------ git shim
/** The shim: finds the real git further along PATH and refuses the role's denied subcommands. */
const SHIM = `#!/usr/bin/env node
// slp's git shim for one seat role (ADR 0016). Written by slp; do not edit.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const denied = new Set((process.env.SLP_GIT_DENY || "").split(",").filter(Boolean));
const args = process.argv.slice(2);
// The subcommand: the first argument after git's own options (-C dir, -c k=v, --flags).
let i = 0;
while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
const sub = args[i];
const forced = sub === "branch" && args.slice(i + 1).some((a) => a === "-D" || a === "-f" || a === "--force");
if ((sub && denied.has(sub)) || forced) {
  process.stderr.write("slp: 'git " + sub + (forced ? " --force" : "") + "' is not for this seat: branches and working copies are slp's, and slp lands lanes. Use slp ask if you need it.\\n");
  process.exit(1);
}
const exe = process.platform === "win32" ? ["git.exe"] : ["git"];
const real = (process.env.PATH || "").split(delimiter).filter((d) => d && resolve(d) !== here)
  .flatMap((d) => exe.map((e) => join(d, e))).find((p) => existsSync(p));
if (!real) { process.stderr.write("slp: git not found on PATH\\n"); process.exit(127); }
const r = spawnSync(real, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;
/** Write the role's git shim (a node script with sh and cmd launchers) and return its directory. */
export async function writeGitShim(env, role) {
    const dir = join(slpHome(env), "bin", role);
    await mkdir(dir, { recursive: true });
    const deny = gitDenied(role).join(",");
    await writeAtomic(join(dir, "git-shim.mjs"), SHIM);
    await writeFile(join(dir, "git"), `#!/bin/sh\nSLP_GIT_DENY='${deny}' exec node "$(dirname "$0")/git-shim.mjs" "$@"\n`, { mode: 0o755 });
    await writeFile(join(dir, "git.cmd"), `@echo off\r\nset "SLP_GIT_DENY=${deny}"\r\nnode "%~dp0git-shim.mjs" %*\r\n`);
    return dir;
}
/** Whether a PATH entry is one of slp's shim directories (slp's own git calls skip them). */
export function isShimDir(entry) {
    return /[\\/]bin[\\/](supervisor|lead|peer|reviewer|critic)[\\/]?$/i.test(entry) && /slp/i.test(entry);
}
