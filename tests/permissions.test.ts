import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { dirtyPaths } from "../src/git.js";
import { choicePrompt } from "../src/permit.js";
import { claudeSettings, gitDenied, isShimDir, writeClaudeSettings, writeGitShim } from "../src/permissions.js";
import { Watcher, watchTiming } from "../src/watcher.js";
import { tempDir, tempRepo, World } from "./helpers.js";

// ADR 0016: seat permissions after seatworks.

describe("role permissions", () => {
  it("denies each role what it must never do", () => {
    expect(gitDenied("peer")).toEqual(expect.arrayContaining(["push", "pull", "checkout", "switch", "stash"]));
    expect(gitDenied("peer")).not.toContain("commit");
    expect(gitDenied("lead")).toEqual(expect.arrayContaining(["commit", "merge", "reset", "rebase", "cherry-pick"]));
    expect(gitDenied("reviewer")).toEqual(expect.arrayContaining(["add", "restore", "config", "commit"]));
    const lead = claudeSettings("lead", false, "/h");
    expect(lead.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git commit *)", "Bash(git -C * push *)", "Read(~/.secrets/**)", "Agent"]));
    expect(lead.permissions.allow).toEqual(expect.arrayContaining(["Bash(slp *)", "Bash(git diff*)", "Bash(npm test*)"]));
    expect(claudeSettings("peer", false, "/h").permissions.deny).not.toContain("Edit");
  });

  it("auto (the default) runs without asking on every platform, sandboxed where it can be; ask asks", () => {
    const windows = claudeSettings("lead", false, "/h");
    expect(windows.permissions.defaultMode).toBe("bypassPermissions");
    expect(windows.skipDangerousModePermissionPrompt).toBe(true);
    expect(windows.sandbox).toBeUndefined();
    const sandboxed = claudeSettings("lead", true, "/h");
    expect(sandboxed.permissions.defaultMode).toBe("bypassPermissions");
    expect(sandboxed.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: ["/h"] } });
    const ask = claudeSettings("lead", false, "/h", "ask");
    expect(ask.permissions.defaultMode).toBeUndefined();
    expect(ask.skipDangerousModePermissionPrompt).toBeUndefined();
    // Denies hold in every mode.
    for (const s of [windows, sandboxed, ask]) expect(s.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Bash(git commit *)", "Read(~/.slp/.env)"]));
  });

  it("merges the owner's allow rules for a role; slp's deny still wins", async () => {
    const lead = claudeSettings("lead", false, "/h", "ask", ["Bash(dotnet build*)", "Edit"]);
    expect(lead.permissions.allow).toEqual(expect.arrayContaining(["Bash(dotnet build*)", "Bash(slp *)"]));
    expect(lead.permissions.deny).toContain("Edit");
    const home = await tempDir("home-");
    const c = defaultConfig();
    c.roles.lead.allow = ["Bash(dotnet build*)"];
    c.permissions.mode = "ask";
    const path = await writeClaudeSettings({ SLP_HOME: home }, "lead", c);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.permissions.allow).toContain("Bash(dotnet build*)");
    expect(written.permissions.defaultMode).toBeUndefined();
  });
});

describe("the git shim", () => {
  async function shim(role: "lead" | "peer") {
    const dir = await writeGitShim({ SLP_HOME: await tempDir("home-") }, role);
    const run = (args: string[]) => spawnSync(process.execPath, [join(dir, "git-shim.mjs"), ...args],
      { encoding: "utf8", env: { ...process.env, SLP_GIT_DENY: gitDenied(role).join(",") } });
    return { dir, run };
  }

  it("refuses the role's denied subcommands, wherever git's own options put them", async () => {
    const { run } = await shim("lead");
    for (const args of [["push"], ["-C", ".", "push", "origin"], ["--git-dir", ".git", "--work-tree", ".", "push"], ["-c", "a=b", "commit", "-m", "x"], ["branch", "-D", "x"], ["checkout", "main"]]) {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is not for this seat");
    }
  });

  it("passes everything else to the real git", async () => {
    const { run } = await shim("peer");
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/git version/);
    expect(run(["push"]).status).toBe(1);
  });

  it("never stands in slp's own way", async () => {
    const { dir } = await shim("lead");
    expect(isShimDir(dir)).toBe(true);
    expect(isShimDir("/usr/bin")).toBe(false);
    const repo = await tempRepo();
    await writeFile(join(repo, "x.txt"), "x");
    const before = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${before}`;
    try {
      expect(await dirtyPaths(repo)).toEqual(["x.txt"]);
    } finally {
      process.env.PATH = before;
    }
  });
});

const NL = String.fromCharCode(10);
const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];
const CLAUDE_PROMPT = "● Checking\n Bash command\n   node -e \"console.log(1)\"\n   Run a quick check\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel";
const CODEX_PROMPT = "• Running npm install\n  Would you like to run the following command?\n  $ npm install left-pad\n› 1. Yes, proceed (y)\n  3. No, and tell Codex what to do differently (esc)";

async function team(inLoop: boolean): Promise<World> {
  const w = await World.create();
  const c = defaultConfig();
  c.human.inLoop = inLoop;
  await writeFile(join(w.home, "config.json"), JSON.stringify(c));
  await w.slp(["start"]);
  w.cli.idleAll();
  await w.as("sup", LANE);
  w.cli.idleAll();
  await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
  w.cli.idleAll();
  return w;
}

describe("slp permit (the Human out of the loop)", () => {
  it("the Supervisor allows a Lead's prompt: Enter on the highlighted Yes, recorded", async () => {
    const w = await team(false);
    const lead = await w.pane("L1");
    w.cli.screens.set(lead, CLAUDE_PROMPT);
    expect(await w.as("sup", ["permit", "L1", "allow", "a harmless check"])).toBe(0);
    expect(w.cli.keys).toEqual([{ target: lead, keys: ["enter"] }]);
    const s = await w.state();
    expect(s.letters.some((l) => l.to === "L1-T1")).toBe(true);
    const events = (await import("../src/core/ledger.js")).readLedger({ SLP_HOME: w.home }, w.project);
    expect((await events).find((e) => e.kind === "permit")).toMatchObject({ seat: "L1", allow: true, by: "sup", why: "a harmless check" });
  });

  it("refusing a Peer's prompt: Esc, the Peer reads why, its Lead is told", async () => {
    const w = await team(false);
    const peer = await w.pane("L1-T1");
    w.cli.screens.set(peer, CODEX_PROMPT);
    expect(await w.as("sup", ["permit", "L1-T1", "deny", "no new dependencies in this lane"])).toBe(0);
    expect(w.cli.keys).toEqual([{ target: peer, keys: ["esc"] }]);
    w.cli.screens.delete(peer);
    expect((await w.inbox("L1")).at(-1)).toMatch(/refused L1-T1's request \(no new dependencies[\s\S]*npm install left-pad/);
    const s = await w.state();
    expect(s.letters.some((l) => l.to === "L1-T1" && l.text.includes("Why: no new dependencies"))).toBe(true);
    // Codex takes "y" to allow.
    w.cli.screens.set(peer, CODEX_PROMPT);
    w.cli.keys.length = 0;
    await w.as("sup", ["permit", "L1-T1", "allow", "fine"]);
    expect(w.cli.keys).toEqual([{ target: peer, keys: ["y"] }]);
  });

  it("never answers a startup dialog, a screen without a prompt, or while the Human is in the loop", async () => {
    const w = await team(false);
    const peer = await w.pane("L1-T1");
    w.cli.screens.set(peer, "  Trust this folder?\n› 1. Trust and continue\n  2. Quit");
    await expect(w.as("sup", ["permit", "L1-T1", "allow", "x"])).rejects.toThrow(/startup dialog/);
    w.cli.screens.set(peer, "> ready");
    await expect(w.as("sup", ["permit", "L1-T1", "allow", "x"])).rejects.toThrow(/not showing a permission prompt/);
    await expect(w.as("L1", ["permit", "L1-T1", "allow", "x"])).rejects.toThrow(/lead does not run/);
    expect(w.cli.keys).toEqual([]);
    const v = await team(true);
    v.cli.screens.set(await v.pane("L1"), CLAUDE_PROMPT);
    await expect(v.as("sup", ["permit", "L1", "allow", "x"])).rejects.toThrow(/Human is in the loop/);
    expect(v.cli.keys).toEqual([]);
  });

  it("the watcher passes a waiting permission to the Supervisor, or to the Human when they are in the loop", async () => {
    let now = Date.now();
    const w = await team(false);
    const lead = await w.pane("L1");
    w.cli.agents.get(lead)!.status = "blocked";
    w.cli.screens.set(lead, CLAUDE_PROMPT);
    const watcher = new Watcher(w.deps(null, () => now), w.project);
    await watcher.tick();
    now += watchTiming.permitAfterMs + 1;
    await watcher.tick();
    expect((await w.inbox("sup")).at(-1)).toMatch(/L1 asks permission for:[\s\S]*node -e[\s\S]*slp permit L1 allow/);
    expect(w.cli.notifications.filter((n) => n.title.includes("L1 waits on you"))).toEqual([]);

    const v = await team(true);
    const vlead = await v.pane("L1");
    v.cli.agents.get(vlead)!.status = "blocked";
    v.cli.screens.set(vlead, CLAUDE_PROMPT);
    const vw = new Watcher(v.deps(null, () => now), v.project);
    // In the loop, the Human hears at once.
    await vw.tick();
    expect(v.cli.notifications.find((n) => n.title.includes("L1 waits on you"))!.body).toContain("node -e");
  });

  it("the Supervisor's own permission prompt reaches the Human at once", async () => {
    const now = Date.now();
    const w = await team(false);
    const sup = await w.pane("sup");
    w.cli.agents.get(sup)!.status = "blocked";
    w.cli.screens.set(sup, CLAUDE_PROMPT);
    await new Watcher(w.deps(null, () => now), w.project).tick();
    expect(w.cli.notifications.find((n) => n.title.includes("sup waits on you"))!.body).toContain("node -e");
  });

  it("a Yes/No slp does not recognise on an idle seat is reported after permitAfterMs", async () => {
    let now = Date.now();
    const w = await team(false);
    const peer = await w.pane("L1-T1");
    w.cli.screens.set(peer, ["Overwrite the generated file?", "❯ 1. Yes", "  2. No"].join(NL));
    const watcher = new Watcher(w.deps(null, () => now), w.project);
    await watcher.tick();
    expect(w.cli.notifications).toEqual([]);
    now += watchTiming.permitAfterMs + 1;
    await watcher.tick();
    await watcher.tick();
    const told = w.cli.notifications.filter((n) => n.title.includes("L1-T1 waits on you"));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("does not recognise");
    expect(told[0]!.body).toContain("Overwrite the generated file");
    expect((await w.inbox("L1")).at(-1)).toContain("L1-T1 waits on a prompt in its pane");
    expect(w.cli.keys).toEqual([]);
  });

  it("takes its timings from the config", async () => {
    const now = Date.now();
    const w = await team(false);
    const c = JSON.parse(await readFile(join(w.home, "config.json"), "utf8"));
    c.watch = { ...c.watch, permitAfterMs: 0 };
    await writeFile(join(w.home, "config.json"), JSON.stringify(c));
    const lead = await w.pane("L1");
    w.cli.agents.get(lead)!.status = "blocked";
    w.cli.screens.set(lead, CLAUDE_PROMPT);
    await new Watcher(w.deps(null, () => now), w.project).tick();
    expect((await w.inbox("sup")).at(-1)).toMatch(/L1 asks permission for/);
  });

  it("knows a Yes/No menu or (y/n) at the bottom of a screen, not one scrolled away", () => {
    expect(choicePrompt(["Continue?", "❯ 1. Yes", "  2. No"].join(NL))).toContain("Continue?");
    expect(choicePrompt("Delete build cache? (y/n)")).toContain("Delete build cache");
    expect(choicePrompt(["❯ 1. Yes", "  2. No", ...Array(20).fill("text"), "> "].join(NL))).toBeNull();
    expect(choicePrompt("> ready")).toBeNull();
  });
});

describe("the bypass warning", () => {
  it("counts as a startup dialog: letters wait and nobody answers it", async () => {
    const { showsStartupDialog } = await import("../src/letters.js");
    expect(showsStartupDialog(["WARNING: Claude Code running in Bypass Permissions mode", "❯ 1. No, exit", "  2. Yes, I accept"].join(NL))).toBe(true);
  });
});
