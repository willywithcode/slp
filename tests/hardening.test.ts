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

describe("second review round", () => {
  it("facts: quoted text in searches, per-file patches, stable stuck keys", async () => {
    const { stepFacts, stuckFact } = await import("../src/watch/facts.js");
    const { codexSteps } = await import("../src/watch/transcripts.js");
    const exec = (cmd: string, at: string) => ({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c", input: `tools.exec_command({cmd:${JSON.stringify(cmd)}})` } });
    const ctx = { owned: ["src/**"], workdir: "/r" };
    expect(stepFacts(codexSteps(exec("rg 'git reset --hard' docs", "t")), ctx)).toEqual([]);
    expect(stepFacts(codexSteps(exec("git reset --hard", "t")), ctx).map((f) => f.fact)).toEqual(["destructive"]);
    // A patch that removes an assert from product code and touches a test is not a weakened test.
    const patch = "*** Begin Patch\n*** Update File: src/a.js\n-  assert(x);\n*** Update File: src/a.test.js\n+  it('more', () => {});\n*** End Patch";
    const steps = codexSteps({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "p", input: `const p = ${JSON.stringify(patch)};` } });
    expect(steps.map((s) => s.files)).toEqual([["src/a.js"], ["src/a.test.js"]]);
    expect(stepFacts(steps, ctx).map((f) => f.fact)).not.toContain("test_weakened");
    // The same loop keeps one key as it goes on.
    const loop = (n: number) => Array.from({ length: n }, (_, i) => codexSteps(exec("npm test", `2026-09-27T10:0${i}:00Z`))).flat();
    expect(stuckFact(loop(3))!.key).toBe(stuckFact(loop(5))!.key);
  });

  it("destructive SQL: deletes without WHERE, with or without a semicolon", async () => {
    const w = await World.create();
    const { dataLossSigns } = await import("../src/risk.js");
    const base = sh(w.repo, "rev-parse", "HEAD");
    await commitFile(w.repo, "src/db.js", "db.run('DELETE FROM users;');\n");
    expect((await dataLossSigns(w.repo, base, "HEAD")).join()).toMatch(/destructive SQL/);
    const base2 = sh(w.repo, "rev-parse", "HEAD");
    await commitFile(w.repo, "src/db2.js", "db.run('DELETE FROM users WHERE id = ?', [id]);\n");
    expect(await dataLossSigns(w.repo, base2, "HEAD")).toEqual([]);
  });

  it("a lane review covers only the work it saw", async () => {
    const w = await started();
    await w.as("sup", ["open-lane", "--title", "Auth tokens", "--outcome", "rotate auth tokens", "--accept", "a", "--write", "src/**"]);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await commitFile(w.repo, "src/a/a.js", "a\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L1", ["accept", "L1-T1"]);
    await w.as("L1", ["start-review", "--lane"]);
    w.cli.idleAll();
    await w.as("L1-R1", ["done", "complete", "looked at all of it"]);
    // More work after the review.
    await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**"]);
    await commitFile(w.repo, "src/b/b.js", "b\n");
    w.cli.idleAll();
    await w.as("L1-T2", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L1", ["accept", "L1-T2"]);
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    expect((await w.inbox("sup")).at(-1)).toMatch(/held for the Human \[at [0-9a-f]{40}\]: it is a high-risk lane/);
    // A fresh lane review of the current work lifts it.
    w.cli.idleAll();
    await w.as("L1", ["start-review", "--lane"]);
    w.cli.idleAll();
    await w.as("L1-R2", ["done", "complete", "looked again"]);
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    expect((await w.state()).lanes.get("L1")!.landed).toBe(true);
  });

  it("an unreadable screen holds letters rather than typing blind", async () => {
    const w = await started();
    await w.as("sup", LANE);
    const lead = await w.pane("L1");
    w.cli.idleAll();
    const original = w.cli.exec;
    w.cli.exec = async (file, args) => (args[0] === "agent" && args[1] === "read" ? { code: 1, stdout: "", stderr: "{\"error\":{\"code\":\"read_failed\",\"message\":\"x\"}}" } : original(file, args));
    const before = w.cli.promptsTo(lead).length;
    await expect(w.as("sup", ["message", "L1", "hi"])).rejects.toThrow(/startup dialog/);
    expect(w.cli.promptsTo(lead).length).toBe(before);
  });
});

describe("third review round", () => {
  it("a gate that changes tracked files does not land", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    const script = join(w.home, "touch.cjs");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(join(w.repo, "README.md"))}, "changed by the gate");`);
    await w.as("sup", ["set-project", "--gate", `node "${script}"`]);
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    expect((await w.inbox("sup")).at(-1)).toMatch(/the gate left changes in .*README\.md/);
    expect((await w.state()).lanes.get("L1")!.open).toBe(true);
  });

  it("a commit posing as a base merge is not covered by an earlier review", async () => {
    const w = await World.create();
    const { laneReviewed } = await import("../src/risk.js");
    sh(w.repo, "checkout", "-q", "-b", "lane/L1-x");
    await commitFile(w.repo, "src/a.js", "a\n");
    const reviewed = sh(w.repo, "rev-parse", "HEAD");
    await commitFile(w.repo, "src/evil.js", "evil\n", "Merge main into lane/L1-x");
    const lane = { id: "L1", base: "main", branch: "lane/L1-x" } as never;
    const state = { reviews: new Map([["R1", { id: "R1", lane: "L1", target: "L1", focus: "", seat: "R1", head: reviewed, done: { summary: "ok" } }]]) } as never;
    expect(await laneReviewed(w.repo, state, lane, sh(w.repo, "rev-parse", "HEAD"))).toBe(false);
    // A real, clean merge of main is covered.
    sh(w.repo, "reset", "-q", "--hard", reviewed);
    sh(w.repo, "checkout", "-q", "main");
    await commitFile(w.repo, "docs/b.md", "b\n");
    sh(w.repo, "checkout", "-q", "lane/L1-x");
    sh(w.repo, "merge", "-q", "--no-ff", "-m", "Merge main into lane/L1-x", "main");
    expect(await laneReviewed(w.repo, state, lane, sh(w.repo, "rev-parse", "HEAD"))).toBe(true);
  });

  it("an override applies to the held commit only; DELETE ... RETURNING counts as destructive", async () => {
    const w = await started();
    await w.as("sup", ["open-lane", "--title", "Cleanup", "--outcome", "remove stale rows", "--accept", "a", "--write", "src/**"]);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "t", "--goal", "g", "--accept", "a", "--own", "src/**"]);
    await commitFile(w.repo, "src/clean.js", "db.run('DELETE FROM sessions RETURNING id');\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L1", ["accept", "L1-T1"]);
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    expect((await w.inbox("sup")).at(-1)).toMatch(/destructive SQL: db\.run\('DELETE FROM sessions RETURNING id'\)/);
    // New work after the hold: the override no longer applies.
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "t2", "--goal", "g", "--accept", "a", "--own", "src/**"]);
    await commitFile(w.repo, "src/more.js", "x\n");
    w.cli.idleAll();
    await w.as("L1-T2", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L1", ["accept", "L1-T2"]);
    await expect(w.as("sup", ["close-lane", "L1", "--land", "--over-risk", "--reason", "the Human agreed"])).rejects.toThrow(/changed since it was held/);
  });
});
