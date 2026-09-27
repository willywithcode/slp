import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { append } from "../src/core/ledger.js";
import { acquireLock, releaseLock } from "../src/core/lock.js";
import { watchLockPath } from "../src/letters.js";
import { Watcher } from "../src/watcher.js";
import { commitFile, sh, World } from "./helpers.js";

// Regressions for findings of the independent reviews of v0.3.

const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];
const DOCS = ["open-lane", "--title", "Docs", "--outcome", "docs", "--accept", "a", "--write", "docs/**"];

async function started(): Promise<World> {
  const w = await World.create();
  await w.slp(["start"]);
  w.cli.idleAll();
  return w;
}

const watchOnce = (w: World) => w.slp(["watch", "--once", "--project", w.project]);

describe("landing", () => {
  it("refuses when the base moves during the gate, and never undoes those commits", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await w.as("sup", DOCS);
    const l2 = (await w.state()).lanes.get("L2")!;
    w.cli.idleAll();
    await w.as("L2", ["start-task", "--title", "d", "--goal", "g", "--accept", "a", "--own", "docs/**"]);
    await commitFile(l2.workdir, "docs/a.md", "a\n");
    w.cli.idleAll();
    await w.as("L2-T1", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L2", ["accept", "L2-T1"]);
    // The gate moves main behind the watcher's back.
    const script = join(w.home, "move-main.cjs");
    await writeFile(script, [
      "const { execFileSync } = require('node:child_process');",
      `const repo = ${JSON.stringify(w.repo)};`,
      "const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();",
      "const c = git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'moved meanwhile');",
      "git('update-ref', 'refs/heads/main', c);",
    ].join("\n"));
    await w.as("sup", ["set-project", "--gate", `node "${script}"`]);
    await w.as("sup", ["close-lane", "L2", "--land"]);
    await watchOnce(w);
    expect((await w.state()).lanes.get("L2")!.open).toBe(true);
    expect(sh(w.repo, "log", "-1", "--format=%s", "main")).toBe("moved meanwhile");
    expect((await w.inbox("sup")).at(-1)).toMatch(/main moved while the lane was being landed/);
  });

  it("finishes a landing that a crash cut short after it was recorded", async () => {
    const w = await started();
    await w.as("sup", DOCS);
    await w.as("sup", ["open-lane", "--title", "Two", "--outcome", "o", "--accept", "a", "--write", "lib/**", "--isolate"]);
    const s = await w.state();
    const lane = s.lanes.get("L2")!;
    // As if the watcher died right after recording the landing.
    await append({ SLP_HOME: w.home }, w.project, () => ({ kind: "request" as const, request: "Q1", what: "land" as const, lane: "L2", by: "sup", note: "", overGate: false }));
    await append({ SLP_HOME: w.home }, w.project, () => ({ kind: "lane-close" as const, lane: "L2", landed: true, reason: "", commit: sh(w.repo, "rev-parse", "main"), overGate: false }));
    w.cli.idleAll();
    await watchOnce(w);
    const after = await w.state();
    expect(after.seats.get("L2")!.live).toBe(false);
    expect(existsSync(lane.workdir)).toBe(false);
    expect(sh(w.repo, "branch", "--list", lane.branch)).toBe("");
  });
});

describe("work is never discarded", () => {
  it("dropping a lane with uncommitted work in its worktree is refused", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await w.as("sup", DOCS);
    const l2 = (await w.state()).lanes.get("L2")!;
    await writeFile(join(l2.workdir, "draft.md"), "unsaved\n");
    w.cli.idleAll();
    await expect(w.as("sup", ["close-lane", "L2", "--drop", "--reason", "x"])).rejects.toThrow(/uncommitted work/);
    expect(existsSync(join(l2.workdir, "draft.md"))).toBe(true);
  });

  it("cutting a parallel task keeps a worktree that has uncommitted changes", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**", "--parallel"]);
    const t = (await w.state()).tasks.get("L1-T1")!;
    await writeFile(join(t.workdir, "wip.txt"), "wip\n");
    w.cli.idleAll();
    await w.as("L1", ["cut", "L1-T1", "wrong idea"]);
    expect(existsSync(join(t.workdir, "wip.txt"))).toBe(true);
    expect(w.out.at(-1)).toMatch(/worktree, which has uncommitted changes/);
  });
});

describe("authority", () => {
  it("a seat cannot run the Human's commands", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await expect(w.as("L1", ["stop", "--force"])).rejects.toThrow(/the Human's command/);
    await expect(w.as("sup", ["watch", "--once"])).rejects.toThrow(/the Human's command/);
    expect((await w.state()).seats.get("L1")!.live).toBe(true);
  });

  it("parallel start-task calls get distinct tasks", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    const lead = await w.pane("L1");
    const { main } = await import("../src/cli.js");
    const run = (own: string) => main(["start-task", "--title", own, "--goal", "g", "--accept", "x", "--own", own, "--parallel"], w.deps(lead), w.repo);
    await Promise.all([run("src/a/**"), run("src/b/**"), run("src/c/**")]);
    const tasks = [...(await w.state()).tasks.values()];
    expect(tasks.map((t) => t.id).sort()).toEqual(["L1-T1", "L1-T2", "L1-T3"]);
    expect(new Set(tasks.map((t) => t.owned[0])).size).toBe(3);
  });

  it("two parallel tasks claiming the same paths: one is refused", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    const lead = await w.pane("L1");
    const { main } = await import("../src/cli.js");
    const run = () => main(["start-task", "--title", "x", "--goal", "g", "--accept", "x", "--own", "src/a/**", "--parallel"], w.deps(lead), w.repo);
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("the watcher retries a letter Herdr refused once", async () => {
    const w = await started();
    await w.as("sup", LANE);
    const lock = watchLockPath({ SLP_HOME: w.home }, w.project);
    const token = await acquireLock(lock);
    try {
      const lead = await w.pane("L1");
      w.cli.agents.get(lead)!.status = "working";
      await w.as("sup", ["message", "L1", "later"]);
      w.cli.idleAll();
      w.cli.failPromptFor.add(lead);
      const watcher = new Watcher(w.deps(null), w.project);
      await watcher.tick();
      expect((await w.state()).letters.at(-1)!.status).toBe("queued");
      w.cli.failPromptFor.clear();
      await watcher.tick();
      expect((await w.inbox("L1")).at(-1)).toContain("later");
    } finally {
      await releaseLock(lock, token);
    }
  });

  it("reports a paste left unsent instead of calling it delivered, and presses nothing it cannot see", async () => {
    const w = await started();
    await w.as("sup", LANE);
    const lead = await w.pane("L1");
    w.cli.idleAll();
    // The text lands in the input box; Herdr reports neither idle nor working.
    w.cli.promptedStatus = "unknown";
    const original = w.cli.exec;
    w.cli.exec = async (file, args) => {
      const r = await original(file, args);
      if (args[0] === "agent" && args[1] === "prompt") w.cli.screens.set(lead, "> [Pasted text #1 +40 lines]");
      return r;
    };
    await expect(w.as("sup", ["message", "L1", "hi"])).rejects.toThrow(/input box but was not submitted/);
    expect(w.cli.keys).toEqual([]);
    const letter = (await w.state()).letters.at(-1)!;
    expect(letter.status).toBe("failed");
    // A trust screen that Herdr calls idle gets no Enter either.
    w.cli.promptedStatus = "idle";
    w.cli.exec = async (file, args) => {
      const r = await original(file, args);
      if (args[0] === "agent" && args[1] === "prompt") w.cli.screens.set(lead, "> [Pasted text #1 +40 lines]\n  Trust this folder?\n› 1. Trust and continue");
      return r;
    };
    await expect(w.as("sup", ["message", "L1", "again"])).rejects.toThrow(/not submitted/);
    expect(w.cli.keys).toEqual([]);
  });
});
