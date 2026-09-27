import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { lockHeldByLiveProcess } from "./core/lock.js";
import { listProjects, loadProject } from "./core/project.js";
import { currentBranch, dirtyPaths, git } from "./git.js";
import { watchLockPath } from "./letters.js";

// `slp update` (`--dry-run` only reports): the latest release from GitHub, installed the way slp was
// installed. A global npm install gets the release tarball; a linked clone
// (a developer's) is fast-forwarded. Running teams keep the old code until
// they are restarted, so the Human is told which ones.

export const REPO = "willywithcode/slp";

/** The installed package: its version and folder (dist/ lives one level down). */
export async function installed(): Promise<{ version: string; root: string }> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  return { version: pkg.version, root };
}

/** Compare dotted versions (1.2.10 > 1.2.9); a leading "v" is ignored. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export async function latestRelease(http: typeof fetch): Promise<string> {
  const res = await http(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "slp-update" },
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => { throw new SlpError(`Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`); });
  if (!res.ok) throw new SlpError(`GitHub answered ${res.status} for the latest release.`);
  const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new SlpError("GitHub's latest release has no version tag.");
  return tag;
}

export type Run = (command: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export const runCommand: Run = (command, args, cwd) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd, shell: process.platform === "win32", windowsHide: true });
  let output = "";
  child.stdout.on("data", (c: Buffer) => { output += c.toString("utf8"); });
  child.stderr.on("data", (c: Buffer) => { output += c.toString("utf8"); });
  child.on("close", (code) => resolve({ code: code ?? 1, output }));
  child.on("error", (error) => resolve({ code: 1, output: error.message }));
});

export interface UpdateOptions { check: boolean; version?: string | undefined; run?: Run; installed?: { version: string; root: string } }

export async function update(deps: Deps, opts: UpdateOptions): Promise<void> {
  const me = opts.installed ?? await installed();
  const target = opts.version ? (opts.version.startsWith("v") ? opts.version : `v${opts.version}`) : await latestRelease(deps.fetch ?? fetch);
  if (!/^v\d+\.\d+\.\d+$/.test(target)) throw new SlpError(`Not a version: ${target}`);
  const fresh = newer(target, me.version);
  deps.out(`installed v${me.version}; ${opts.version ? "asked for" : "latest"} ${target}`);
  if (opts.check) {
    deps.out(fresh ? `A newer slp is out: run \`slp update\`.` : "Up to date.");
    return;
  }
  if (!fresh && !opts.version) { deps.out("Up to date."); return; }
  const run = opts.run ?? runCommand;
  const linked = await stat(join(me.root, ".git")).then(() => true, () => false);
  if (linked) {
    // A developer's clone: fast-forward it, never rewrite local work.
    const branch = await currentBranch(me.root);
    if (branch !== "main") throw new SlpError(`slp runs from a clone (${me.root}) on branch ${branch ?? "(detached)"}; switch it to main to update.`);
    const dirty = await dirtyPaths(me.root);
    if (dirty.length) throw new SlpError(`slp runs from a clone (${me.root}) with uncommitted changes; commit or stash them first.`);
    const pulled = await git(me.root, ["pull", "--ff-only", "--tags"]);
    if (pulled.code !== 0) throw new SlpError(`git pull in ${me.root} failed: ${(pulled.stderr || pulled.stdout).trim()}`);
    if (opts.version) {
      const out = await git(me.root, ["checkout", "--quiet", target]);
      if (out.code !== 0) throw new SlpError(`git checkout ${target} failed: ${out.stderr.trim()}`);
    }
    deps.out(`updated the clone at ${me.root} (dist/ is committed; nothing to build)`);
  } else {
    const tarball = `https://github.com/${REPO}/archive/refs/tags/${target}.tar.gz`;
    deps.out(`installing ${tarball}`);
    const r = await run("npm", ["install", "-g", tarball], me.root);
    if (r.code !== 0) throw new SlpError(`npm install failed:\n${r.output.trim().split(/\r?\n/).slice(-15).join("\n")}`);
    deps.out(`installed slp ${target}`);
  }
  await remindRunningTeams(deps);
}

/** Teams whose watcher still runs the old code. */
async function remindRunningTeams(deps: Deps): Promise<void> {
  const running: string[] = [];
  for (const id of await listProjects(deps.env)) {
    if (await lockHeldByLiveProcess(watchLockPath(deps.env, id))) running.push((await loadProject(deps.env, id))?.root ?? id);
  }
  if (running.length) {
    deps.out(`Teams still running the old slp (\`slp stop\` then \`slp start\` in each):\n${running.map((r) => `- ${r}`).join("\n")}`);
  }
}
