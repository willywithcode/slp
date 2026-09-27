import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { acquireLock, releaseLock } from "../src/core/lock.js";
import { Herdr } from "../src/herdr.js";
import { INLINE_LIMIT, watchLockPath } from "../src/letters.js";
import { startRetry } from "../src/seats.js";
import { Watcher, watchTiming } from "../src/watcher.js";
import { accountsConfig, World } from "./helpers.js";

const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];

async function withLane(): Promise<World> {
  const w = await World.create();
  await w.slp(["start"]);
  w.cli.idleAll();
  await w.as("sup", LANE);
  w.cli.idleAll();
  return w;
}

async function holdWatch(w: World): Promise<() => Promise<void>> {
  const lock = watchLockPath({ SLP_HOME: w.home }, w.project);
  const token = await acquireLock(lock);
  return () => releaseLock(lock, token);
}

describe("delivery", () => {
  it("delivers at once when no watcher runs, even to a busy seat", async () => {
    const w = await withLane();
    w.cli.agents.get(await w.pane("L1"))!.status = "working";
    await w.as("sup", ["message", "L1", "one"]);
    expect((await w.inbox("L1")).at(-1)).toContain("one");
  });

  it("holds letters for a busy seat and the watcher delivers them in one message", async () => {
    const w = await withLane();
    const release = await holdWatch(w);
    try {
      const lead = await w.pane("L1");
      w.cli.agents.get(lead)!.status = "working";
      const before = (await w.inbox("L1")).length;
      await w.as("sup", ["message", "L1", "first"]);
      await w.as("sup", ["message", "L1", "second"]);
      expect((await w.inbox("L1")).length).toBe(before);
      expect((await w.state()).letters.filter((l) => l.status === "queued")).toHaveLength(2);
      // Still busy: nothing moves.
      await new Watcher(w.deps(null), w.project).tick();
      expect((await w.inbox("L1")).length).toBe(before);
      w.cli.idleAll();
      await new Watcher(w.deps(null), w.project).tick();
      const inbox = await w.inbox("L1");
      expect(inbox.length).toBe(before + 1);
      expect(inbox.at(-1)).toMatch(/first[\s\S]*---[\s\S]*second/);
      expect((await w.state()).letters.every((l) => l.status === "delivered")).toBe(true);
    } finally {
      await release();
    }
  });

  it("a sender that cannot reach Herdr leaves its letter for the watcher", async () => {
    const w = await withLane();
    const lead = await w.pane("L1");
    const sandboxed = { ...w.deps(lead), herdr: new Herdr(async () => ({ code: 1, stdout: "", stderr: "Access is denied." }), "herdr") };
    const { main } = await import("../src/cli.js");
    // Without a watcher: a clear error, the letter stays recorded as failed.
    await expect(main(["report", "progress", "halfway"], sandboxed, w.repo)).rejects.toThrow(/cannot reach Herdr and no watcher runs/);
    const release = await holdWatch(w);
    try {
      expect(await main(["report", "progress", "still going"], sandboxed, w.repo)).toBe(0);
      expect(w.out.at(-1)).toMatch(/watcher will deliver it within seconds/);
      await new Watcher(w.deps(null), w.project).tick();
      expect((await w.inbox("sup")).at(-1)).toContain("still going");
    } finally {
      await release();
    }
  });

  it("puts long letters in a file and points the seat at it", async () => {
    const w = await withLane();
    const long = "x".repeat(INLINE_LIMIT + 10);
    await w.as("sup", ["message", "L1", "-"], long);
    const text = (await w.inbox("L1")).at(-1)!;
    const file = /read it from this file before acting:\n(.+)/.exec(text)![1]!;
    expect(await readFile(file.trim(), "utf8")).toBe(long);
  });

  it("presses Enter once when a prompt sits unsent in the input box", async () => {
    const w = await withLane();
    const lead = await w.pane("L1");
    w.cli.promptedStatus = "idle";
    w.cli.screens.set(lead, "output\n> [Pasted text #1 +40 lines]");
    await w.as("sup", ["message", "L1", "hello"]);
    expect(w.cli.keys).toEqual([{ target: lead, keys: ["enter"] }]);
  });

  it("redelivers only what Herdr refused, unless forced", async () => {
    const w = await withLane();
    const lead = await w.pane("L1");
    w.cli.failPromptFor.add(lead);
    await expect(w.as("sup", ["message", "L1", "hi"])).rejects.toThrow(/NOT delivered to L1: agent_blocked.*slp redeliver/);
    const seq = (await w.state()).letters.at(-1)!.seq;
    await expect(w.as("L1", ["redeliver", String(seq)])).rejects.toThrow(/only its sender/);
    w.cli.failPromptFor.clear();
    expect(await w.as("sup", ["redeliver", String(seq)])).toBe(0);
    await expect(w.as("sup", ["redeliver", String(seq)])).rejects.toThrow(/already delivered/);
    // The Human may redeliver any letter.
    expect(await w.slp(["redeliver", String(seq), "--force"])).toBe(0);
  });

  it("letters to a closed seat fail loudly", async () => {
    const w = await withLane();
    await expect(w.as("sup", ["message", "L9", "x"])).rejects.toThrow(/No live seat "L9"/);
  });
});

describe("seats", () => {
  it("never answers a trust dialog: no introduction until the Human does", async () => {
    const w = await World.create();
    const original = w.cli.exec;
    w.cli.exec = async (file, args) => {
      const r = await original(file, args);
      if (args[0] === "agent" && args[1] === "start") w.cli.screens.set(args[args.indexOf("--pane") + 1]!, "Do you trust the files in this folder?");
      return r;
    };
    await w.slp(["start"]);
    expect(w.out.some((l) => l.includes("NEEDS ATTENTION") && l.includes("slp intro sup"))).toBe(true);
    const sup = await w.pane("sup");
    expect(w.cli.promptsTo(sup)).toEqual([]);
    expect(w.cli.keys).toEqual([]);
    w.cli.screens.clear();
    expect(await w.slp(["intro", "sup"])).toBe(0);
    expect(w.cli.promptsTo(sup)[0]).toContain("[SLP INTRO");
  });

  it("records a seat Herdr reports blocked at startup; the watcher introduces it once ready", async () => {
    const w = await World.create();
    await mkdir(join(w.home, "projects", w.project), { recursive: true });
    const release = await holdWatch(w);
    try {
      const original = w.cli.exec;
      w.cli.exec = async (file, args) => {
        const r = await original(file, args);
        if (args[0] === "agent" && args[1] === "start") {
          w.cli.agents.get(args[args.indexOf("--pane") + 1]!)!.status = "blocked";
          return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_ready", message: `agent ${args[2]} is blocked during startup and is not ready for prompts` } }) };
        }
        return r;
      };
      expect(await w.slp(["start"])).toBe(0);
      const sup = await w.pane("sup");
      expect(w.out.some((l) => l.includes("NEEDS ATTENTION") && l.includes("answer it yourself"))).toBe(true);
      expect(w.cli.notifications.some((n) => n.title.includes("sup needs you"))).toBe(true);
      await new Watcher(w.deps(null), w.project).tick();
      expect(w.cli.promptsTo(sup)).toEqual([]);
      expect(w.cli.keys).toEqual([]);
      w.cli.idleAll(); // the Human answered the dialog
      await new Watcher(w.deps(null), w.project).tick();
      expect(w.cli.promptsTo(sup)[0]).toContain("[SLP INTRO");
    } finally {
      await release();
    }
  });

  it("never types into a trust dialog Herdr calls idle (Codex, seen live)", async () => {
    const w = await withLane();
    const dialog = "  Folder access\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit";
    const original = w.cli.exec;
    w.cli.exec = async (file, args) => {
      const r = await original(file, args);
      if (args[0] === "agent" && args[1] === "start" && args.includes("codex")) w.cli.screens.set(args[args.indexOf("--pane") + 1]!, dialog);
      return r;
    };
    // No watcher: the task is recorded, the Human is told; nothing reaches the pane.
    expect(await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"])).toBe(0);
    expect(w.out.some((l) => l.includes("NEEDS ATTENTION") && l.includes("slp intro L1-T1"))).toBe(true);
    const peer = await w.pane("L1-T1");
    expect(w.cli.promptsTo(peer)).toEqual([]);
    expect(w.cli.keys).toEqual([]);
    expect(w.cli.notifications.some((n) => n.title.includes("L1-T1 needs you"))).toBe(true);
    expect((await w.state()).letters.find((l) => l.to === "L1-T1")!.status).toBe("failed");
    await expect(w.slp(["intro", "L1-T1"])).rejects.toThrow(/startup dialog only the Human answers/);

    // With a watcher: letters wait, the Human is told once, delivery follows the answer.
    const release = await holdWatch(w);
    try {
      await w.as("L1", ["message", "L1-T1", "one more thing"]);
      const watcher = new Watcher(w.deps(null), w.project);
      await watcher.tick();
      await watcher.tick();
      expect(w.cli.promptsTo(peer)).toEqual([]);
      expect(w.cli.notifications.filter((n) => n.title.includes("L1-T1 waits on you"))).toHaveLength(1);
      w.cli.screens.delete(peer);
      await watcher.tick();
      expect(w.cli.promptsTo(peer).at(-1)).toContain("one more thing");
      // The Human resends the first letter: introduction and brief together.
      w.cli.idleAll();
      expect(await w.slp(["intro", "L1-T1"])).toBe(0);
      const first = w.cli.promptsTo(peer).at(-1)!;
      expect(first).toContain("[SLP TASK");
      expect(first).toMatch(/You are "L1-T1"[\s\S]*Task L1-T1: a/);
    } finally {
      await release();
    }
  });

  it("replaces a pane that stays busy and prepares the new one too", async () => {
    const w = await World.create();
    const config = defaultConfig();
    config.launchers.claude!.env = { ANTHROPIC_API_KEY: null };
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    const original = w.cli.exec;
    let refused = 0;
    w.cli.exec = async (file, args) => {
      if (args[0] === "agent" && args[1] === "start" && refused < startRetry.attempts) {
        refused++;
        return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" } }) };
      }
      return original(file, args);
    };
    await w.slp(["start"]);
    const sup = await w.pane("sup");
    expect(w.out.some((l) => /is occupied; using/.test(l))).toBe(true);
    expect(w.cli.ran.filter((r) => r.command.includes("unset ANTHROPIC_API_KEY")).map((r) => r.pane)).toContain(sup);
  });

  it("starts a seat with the machine's own command, arguments quoted for its shell (ADR 0011)", async () => {
    const w = await World.create();
    await writeFile(join(w.home, "config.json"), JSON.stringify(accountsConfig()));
    w.cli.shell = "pwsh.exe";
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    const lead = await w.pane("L1");
    const typed = w.cli.ran.filter((r) => r.pane === lead).map((r) => r.command);
    expect(typed[0]).toContain("Write-Output ('slp-ready-' + '");
    expect(typed[1]!.startsWith("claude-as acc1 '--model' 'claude-opus-5-5[1m]' '--effort' 'high' '--session-id' '")).toBe(true);
    expect(typed[1]!.endsWith("claude-lead.json'")).toBe(true);
    // No `herdr agent start` for it: Herdr recognised the agent the command started.
    expect(w.cli.calls.some((c) => c[0] === "agent" && c[1] === "start" && c.includes(lead))).toBe(false);
    expect((await w.state()).seats.get("L1")!.launcher).toBe("claude-acc1");
    expect((await w.inbox("L1"))[0]).toContain("[SLP DIRECTIVE");
  });

  it("reports what the pane shows when the command starts no agent", async () => {
    const w = await World.create();
    await writeFile(join(w.home, "config.json"), JSON.stringify(accountsConfig()));
    w.cli.failCommands.add("claude-as");
    await w.slp(["start"]);
    w.cli.idleAll();
    await expect(w.as("sup", LANE)).rejects.toThrow(/No agent started in pane .* from: claude-as acc1/);
  });

  it("still takes a launcher's environment and preparation (older configs)", async () => {
    const w = await World.create();
    const config = accountsConfig();
    config.launchers["claude-acc1"] = { agent: "claude", env: { ANTHROPIC_API_KEY: null }, prep: { powershell: "$env:X = 'from-prep'" } };
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    w.cli.shell = "pwsh.exe";
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    const lead = await w.pane("L1");
    const first = w.cli.ran.find((r) => r.pane === lead)!.command;
    expect(first).toContain("Remove-Item Env:ANTHROPIC_API_KEY");
    expect(first).toContain("$env:X = 'from-prep'");
    expect(w.cli.calls.some((c) => c[0] === "agent" && c[1] === "start" && c.includes(lead))).toBe(true);
  });

  it("knows a seat only by its pane and workspace", async () => {
    const w = await withLane();
    const lead = await w.pane("L1");
    const { main } = await import("../src/cli.js");
    const elsewhere = { ...w.deps(lead), env: { ...w.deps(lead).env, HERDR_WORKSPACE_ID: "w2" } };
    await expect(main(["whoami"], elsewhere, w.repo)).rejects.toThrow(/not a seat/);
    expect(await w.as("L1", ["whoami"])).toBe(0);
    expect(w.out.at(-1)).toMatch(/^L1: lead in lane L1/);
  });
});

describe("watcher rules", () => {
  it("reports a seat whose pane is gone, after a few looks", async () => {
    const w = await withLane();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    w.cli.agents.delete(await w.pane("L1-T1"));
    const watcher = new Watcher(w.deps(null), w.project);
    for (let i = 0; i < watchTiming.goneTicks; i++) await watcher.tick();
    expect((await w.state()).seats.get("L1-T1")!.live).toBe(false);
    expect((await w.inbox("L1")).at(-1)).toMatch(/L1-T1 \(peer\) is gone/);
  });

  it("tells the Human and the superior about a seat stuck on a prompt", async () => {
    const w = await withLane();
    let now = Date.now();
    const watcher = new Watcher(w.deps(null, () => now), w.project);
    w.cli.agents.get(await w.pane("L1"))!.status = "blocked";
    await watcher.tick();
    expect(w.cli.notifications).toEqual([]);
    now += watchTiming.blockedMs + 1;
    await watcher.tick();
    await watcher.tick();
    expect(w.cli.notifications.filter((n) => n.title.includes("L1 waits on you"))).toHaveLength(1);
    expect((await w.inbox("sup")).at(-1)).toMatch(/L1 has waited on a prompt/);
  });
});
