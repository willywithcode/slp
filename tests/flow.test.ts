import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitFile, sh, World } from "./helpers.js";

async function started(): Promise<World> {
  const w = await World.create();
  expect(await w.slp(["start"])).toBe(0);
  w.cli.idleAll();
  return w;
}

const LANE = ["open-lane", "--title", "Greeting", "--outcome", "The app greets by name",
  "--accept", "hello(name) returns 'hello <name>'", "--write", "src/**"];

describe("start", () => {
  it("opens the Supervisor beside the Human and a watcher below", async () => {
    const w = await started();
    const s = await w.state();
    const sup = s.seats.get("sup")!;
    expect(sup.role).toBe("supervisor");
    expect(sup.tabId).toBe("w1:t1");
    expect(w.cli.calls.some((c) => c[0] === "pane" && c[1] === "split" && c[2] === "w1:p0" && c.includes("right"))).toBe(true);
    expect(w.cli.ran.some((r) => r.command === `slp watch --project ${w.project}`)).toBe(true);
    const intro = await w.inbox("sup");
    expect(intro[0]).toContain("[SLP INTRO");
    expect(intro[0]).toContain("slp guide");
    // Claude seats get a fixed session id and only slp pre-approved.
    const start = w.cli.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
    expect(start).toContain("--session-id");
    expect(start).toContain("Bash(slp *)");
    expect(await readFile(join(w.home, "projects", w.project, "CONTEXT.md"), "utf8")).toContain("# Concept");
  });

  it("refuses a second start and outside Herdr", async () => {
    const w = await started();
    await expect(w.slp(["start"])).rejects.toThrow(/already running/);
    const v = await World.create();
    await expect(v.slp(["start"], null)).rejects.toThrow(/Herdr pane/);
  });

  it("uses slp.cmd for the watcher in PowerShell", async () => {
    const w = await World.create();
    w.cli.shell = "pwsh.exe";
    await w.slp(["start"]);
    expect(w.cli.ran.some((r) => r.command.startsWith("slp.cmd watch"))).toBe(true);
  });
});

describe("the core loop", () => {
  it("lane → task → hand-back → accept → ready → gate → land", async () => {
    const w = await started();
    expect(await w.as("sup", ["set-project", "--gate", "node -e \"process.exit(0)\""])).toBe(0);
    expect(await w.as("sup", LANE)).toBe(0);
    let s = await w.state();
    const lane = s.lanes.get("L1")!;
    expect(lane.inCheckout).toBe(true);
    expect(lane.branch).toBe("lane/L1-greeting");
    expect(sh(w.repo, "branch", "--show-current")).toBe("lane/L1-greeting");
    const lead = s.seats.get("L1")!;
    expect(lead.role).toBe("lead");
    expect(lead.tabId).not.toBe("w1:t1");
    const leadMail = await w.inbox("L1");
    expect(leadMail.some((m) => m.includes("[SLP DIRECTIVE") && m.includes("The app greets by name"))).toBe(true);
    w.cli.idleAll();

    expect(await w.as("L1", ["start-task", "--title", "hello", "--goal", "add hello()", "--accept", "unit test passes",
      "--own", "src/hello/**"])).toBe(0);
    s = await w.state();
    const task = s.tasks.get("L1-T1")!;
    expect(task.mode).toBe("lane");
    expect(task.workdir).toBe(w.repo);
    const peer = s.seats.get("L1-T1")!;
    expect(peer.role).toBe("peer");
    expect(peer.tabId).toBe(lead.tabId);
    const codex = w.cli.calls.find((c) => c[0] === "agent" && c[1] === "start" && c.includes("codex"))!;
    expect(codex).toEqual(expect.arrayContaining(["--no-daemon", "-m", "gpt-6-sol"]));
    expect((await w.inbox("L1-T1")).some((m) => m.includes("[SLP TASK") && m.includes("src/hello/**"))).toBe(true);
    w.cli.idleAll();

    // A complete hand-back needs evidence and committed work.
    await expect(w.as("L1-T1", ["done", "complete", "did it"])).rejects.toThrow(/--check/);
    await commitFile(w.repo, "src/hello/index.js", "export const hello = (n) => `hello ${n}`;\n");
    expect(await w.as("L1-T1", ["done", "complete", "--check", "node test: 1 passed", "-"], "added hello()")).toBe(0);
    const handback = (await w.inbox("L1")).at(-1)!;
    expect(handback).toContain("[SLP HANDBACK");
    expect(handback).toContain("src/hello/index.js");
    expect(handback).not.toContain("OUTSIDE");
    w.cli.idleAll();

    await expect(w.as("L1", ["report", "ready", "done"])).rejects.toThrow(/L1-T1 is handed-back/);
    expect(await w.as("L1", ["accept", "L1-T1", "good"])).toBe(0);
    expect((await w.state()).seats.get("L1-T1")!.live).toBe(false);
    expect(await w.as("L1", ["report", "ready", "hello() exists and is tested"])).toBe(0);

    expect(await w.slp(["watch", "--once", "--project", w.project])).toBe(0);
    s = await w.state();
    expect(s.gates.at(-1)!.ok).toBe(true);
    const report = (await w.inbox("sup")).at(-1)!;
    expect(report).toContain("[SLP REPORT");
    expect(report).toContain("GREEN");
    w.cli.idleAll();

    const before = sh(w.repo, "rev-parse", "main");
    expect(await w.as("sup", ["close-lane", "L1", "--land"])).toBe(0);
    expect(await w.slp(["watch", "--once", "--project", w.project])).toBe(0);
    s = await w.state();
    const closed = s.lanes.get("L1")!;
    expect(closed.open).toBe(false);
    expect(closed.landed).toBe(true);
    expect(sh(w.repo, "rev-parse", "main")).toBe(closed.commit);
    expect(sh(w.repo, "rev-parse", "main^")).toBe(before);
    expect(sh(w.repo, "log", "-1", "--format=%s", "main")).toBe("Greeting");
    expect(sh(w.repo, "branch", "--show-current")).toBe("main");
    expect(sh(w.repo, "branch", "--list", "lane/*")).toBe("");
    expect(existsSync(join(w.repo, "src/hello/index.js"))).toBe(true);
    expect(s.seats.get("L1")!.live).toBe(false);
    expect(w.cli.closedTabs).toContain(lead.tabId);
    expect((await w.inbox("sup")).at(-1)).toContain("[SLP LANDED");
    expect(w.cli.notifications.some((n) => n.title.includes("L1 landed"))).toBe(true);
  });

  it("a red gate stops the landing and tells the Lead", async () => {
    const w = await started();
    await w.as("sup", ["set-project", "--gate", "node -e \"process.exit(3)\""]);
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    const s = await w.state();
    expect(s.lanes.get("L1")!.open).toBe(true);
    expect((await w.inbox("sup")).at(-1)).toMatch(/Could not land L1: the gate is red/);
    expect((await w.inbox("L1")).at(-1)).toMatch(/Landing L1 failed/);
    // Over the gate with a reason, it lands.
    w.cli.idleAll();
    await expect(w.as("sup", ["close-lane", "L1", "--land", "--over-gate"])).rejects.toThrow(/--reason/);
    await w.as("sup", ["close-lane", "L1", "--land", "--over-gate", "--reason", "flaky suite, Human agreed"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    expect((await w.state()).lanes.get("L1")!.landed).toBe(true);
  });

  it("brings the lane up to date with a moved base before landing", async () => {
    const w = await started();
    await w.as("sup", LANE);
    // A second lane works in its own worktree while the first holds the checkout.
    await w.as("sup", ["open-lane", "--title", "Docs", "--outcome", "docs", "--accept", "a doc", "--write", "docs/**"]);
    const s = await w.state();
    const l2 = s.lanes.get("L2")!;
    expect(l2.inCheckout).toBe(false);
    expect(existsSync(l2.workdir)).toBe(true);
    w.cli.idleAll();
    await w.as("L2", ["start-task", "--title", "doc", "--goal", "g", "--accept", "a", "--own", "docs/**"]);
    await commitFile(l2.workdir, "docs/a.md", "a\n");
    w.cli.idleAll();
    await w.as("L2-T1", ["done", "complete", "--check", "cat docs/a.md: a", "wrote docs/a.md"]);
    await w.as("L2", ["accept", "L2-T1"]);
    await w.as("sup", ["close-lane", "L2", "--land"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    expect((await w.state()).lanes.get("L2")!.landed).toBe(true);
    expect(existsSync(l2.workdir)).toBe(false);

    // L1 (in the checkout) now lands on top of L2's commit.
    await commitFile(w.repo, "src/x.js", "x\n");
    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    const l1 = (await w.state()).lanes.get("L1")!;
    expect(l1.landed).toBe(true);
    expect(sh(w.repo, "log", "--format=%s", "main").split("\n")).toEqual(["Greeting", "Docs", "init"]);
    expect(sh(w.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(w.repo, "docs/a.md"))).toBe(true);
  });
});

describe("lanes", () => {
  it("refuses overlapping and catch-all write sets", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await expect(w.as("sup", ["open-lane", "--title", "b", "--outcome", "o", "--accept", "a", "--write", "src/b/**"])).rejects.toThrow(/overlaps open lane L1/);
    await expect(w.as("sup", ["open-lane", "--title", "b", "--outcome", "o", "--accept", "a", "--write", "**"])).rejects.toThrow(/too wide/);
    await expect(w.as("sup", ["open-lane", "--title", "b", "--outcome", "o", "--accept", "a"])).rejects.toThrow(/write set/);
  });

  it("opens a Critic when the Human's words are given, and it reports once", async () => {
    const w = await started();
    await w.as("sup", [...LANE, "--human", "make it greet people"]);
    const s = await w.state();
    const critic = s.seats.get("L1-critic")!;
    expect(critic.role).toBe("critic");
    expect(w.cli.calls.find((c) => c[0] === "agent" && c[1] === "start" && c[2]!.endsWith("l1-critic"))).toEqual(
      expect.arrayContaining(["--disallowedTools", "Edit", "Write"]));
    expect((await w.inbox("L1-critic")).some((m) => m.includes("make it greet people"))).toBe(true);
    w.cli.idleAll();
    await expect(w.as("L1-critic", ["findings", "--finding", "weird :: x"])).rejects.toThrow(/missing\|added/);
    expect(await w.as("L1-critic", ["findings", "--finding", "ambiguity :: greet by name or 'hello world'?"])).toBe(0);
    expect((await w.inbox("sup")).at(-1)).toContain("[SLP CRITIQUE");
    await expect(w.as("L1-critic", ["findings"])).rejects.toThrow(/already reported/);
    // The watcher closes it once its turn is over.
    w.cli.idleAll();
    await w.slp(["watch", "--once", "--project", w.project]);
    expect((await w.state()).seats.get("L1-critic")!.live).toBe(false);
  });

  it("drops a lane: seats closed, checkout back on base, branch kept", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await expect(w.as("sup", ["close-lane", "L1", "--drop"])).rejects.toThrow(/why/);
    expect(await w.as("sup", ["close-lane", "L1", "--drop", "--reason", "not needed"])).toBe(0);
    const s = await w.state();
    expect(s.lanes.get("L1")!.open).toBe(false);
    expect(s.seats.get("L1")!.live).toBe(false);
    expect(sh(w.repo, "branch", "--show-current")).toBe("main");
    expect(sh(w.repo, "branch", "--list", "lane/*")).toContain("lane/L1-greeting");
  });

  it("amends a lane and tells its Lead", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("sup", ["amend-lane", "L1", "--why", "Human asked", "--accept", "also goodbye()"]);
    expect((await w.state()).lanes.get("L1")!.acceptance).toEqual(["also goodbye()"]);
    expect((await w.inbox("L1")).at(-1)).toContain("also goodbye()");
  });
});

describe("tasks", () => {
  async function laneOpen(): Promise<World> {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    return w;
  }

  it("one writer per working copy; parallel tasks get their own and merge on accept", async () => {
    const w = await laneOpen();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await expect(w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**"])).rejects.toThrow(/holds the lane's working copy/);
    await expect(w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/a/x/**", "--parallel"])).rejects.toThrow(/overlap L1-T1/);
    await expect(w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "lib/**", "--parallel"])).rejects.toThrow(/outside lane L1/);
    expect(await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**", "--parallel", "--preset", "luna"])).toBe(0);
    const s = await w.state();
    const t2 = s.tasks.get("L1-T2")!;
    expect(t2.mode).toBe("parallel");
    expect(t2.workdir).not.toBe(w.repo);
    expect(w.cli.calls.filter((c) => c[0] === "agent" && c[1] === "start").at(-1)).toContain("gpt-6-luna");
    w.cli.idleAll();
    await commitFile(t2.workdir, "src/b/b.js", "b\n");
    await w.as("L1-T2", ["done", "complete", "--check", "ok", "b done"]);
    // T1 still writes in the lane's copy.
    await expect(w.as("L1", ["accept", "L1-T2"])).rejects.toThrow(/L1-T1 is writing/);
    await commitFile(w.repo, "src/a/a.js", "a\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "a done"]);
    expect(await w.as("L1", ["accept", "L1-T2"])).toBe(0);
    expect(existsSync(join(w.repo, "src/b/b.js"))).toBe(true);
    expect(existsSync(t2.workdir)).toBe(false);
    expect(sh(w.repo, "branch", "--list", "task/*")).toBe("");
    expect(await w.as("L1", ["accept", "L1-T1"])).toBe(0);
  });

  it("rotates Peers across the configured launchers", async () => {
    const w = await World.create();
    const { writeFile } = await import("node:fs/promises");
    const { defaultConfig } = await import("../src/core/config.js");
    const config = defaultConfig("linux");
    config.launchers["codex-b"] = { agent: "codex", env: { CODEX_HOME: "{home}/.codex-b" }, prep: {} };
    config.roles.peer.use = ["codex", "codex-b"];
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**", "--parallel"]);
    const s = await w.state();
    expect(s.seats.get("L1-T1")!.launcher).toBe("codex");
    expect(s.seats.get("L1-T2")!.launcher).toBe("codex-b");
    // The launcher's environment was typed into the seat's own pane first.
    expect(w.cli.ran.some((r) => r.pane === s.seats.get("L1-T2")!.paneId && r.command.includes("export CODEX_HOME="))).toBe(true);
  });

  it("rework and cut", async () => {
    const w = await laneOpen();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "partial", "--left", "tests", "started"]);
    await expect(w.as("L1-T1", ["done", "partial", "again"])).rejects.toThrow(/handed-back/);
    expect(await w.as("L1", ["rework", "L1-T1", "add the tests"])).toBe(0);
    expect((await w.inbox("L1-T1")).at(-1)).toContain("[SLP REWORK");
    expect((await w.state()).tasks.get("L1-T1")!.state).toBe("rework");
    expect(await w.as("L1", ["cut", "L1-T1", "approach is wrong"])).toBe(0);
    const s = await w.state();
    expect(s.tasks.get("L1-T1")!.state).toBe("cut");
    expect(s.seats.get("L1-T1")!.live).toBe(false);
  });

  it("flags hand-backs that changed files outside the owned paths", async () => {
    const w = await laneOpen();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await commitFile(w.repo, "src/other.js", "o\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "done"]);
    expect((await w.inbox("L1")).at(-1)).toContain("OUTSIDE owned paths (src/a/**): src/other.js");
  });

  it("a Reviewer reads, reports findings, and is closed by the watcher", async () => {
    const w = await laneOpen();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await commitFile(w.repo, "src/a/a.js", "a\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "done"]);
    expect(await w.as("L1", ["start-review", "--task", "L1-T1", "--focus", "edge cases"])).toBe(0);
    const s = await w.state();
    expect(s.seats.get("L1-R1")!.role).toBe("reviewer");
    expect((await w.inbox("L1-R1")).some((m) => m.includes("[SLP REVIEW") && m.includes("edge cases"))).toBe(true);
    w.cli.idleAll();
    await expect(w.as("L1-R1", ["done", "complete", "--finding", "bad", "x"])).rejects.toThrow(/finding is/);
    expect(await w.as("L1-R1", ["done", "complete", "--finding", "high :: src/a/a.js:1 :: no export :: file has only 'a'", "read it"])).toBe(0);
    expect((await w.inbox("L1")).at(-1)).toContain("[high] src/a/a.js:1: no export");
    w.cli.idleAll();
    await w.slp(["watch", "--once", "--project", w.project]);
    expect((await w.state()).seats.get("L1-R1")!.live).toBe(false);
  });
});

describe("roles and talk", () => {
  it("refuses verbs outside a role", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    await expect(w.as("L1-T1", LANE)).rejects.toThrow(/peer does not run `slp open-lane`/);
    await expect(w.as("L1", ["close-lane", "L1", "--land"])).rejects.toThrow(/lead does not run/);
    await expect(w.as("sup", ["start-task", "--title", "a"])).rejects.toThrow(/supervisor does not run/);
    await expect(w.slp(["open-lane"], "w1:p99")).rejects.toThrow(/not a seat/);
  });

  it("asks go to the superior and are answered; the watcher reminds", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    expect(await w.as("L1-T1", ["ask", "question", "which greeting?", "--default", "use hello"])).toBe(0);
    expect((await w.inbox("L1")).at(-1)).toMatch(/A1 \(question\): which greeting\?[\s\S]*use hello/);
    await expect(w.as("sup", ["answer", "A9", "x"])).rejects.toThrow(/No ask A9/);
    expect(await w.as("L1", ["ask", "need", "a db"])).toBe(0);
    expect((await w.inbox("sup")).at(-1)).toContain("A2 (need)");

    // Reminder after the delay.
    w.cli.idleAll();
    const { Watcher, watchTiming } = await import("../src/watcher.js");
    const later = Date.now() + watchTiming.askReminderMs + 1000;
    await new Watcher(w.deps(null, () => later), w.project).tick();
    expect((await w.inbox("L1")).at(-1)).toContain("[SLP STILL_OPEN");

    w.cli.idleAll();
    expect(await w.as("L1", ["answer", "A1", "hello"])).toBe(0);
    expect((await w.inbox("L1-T1")).at(-1)).toContain("[SLP ANSWER");
    await expect(w.as("L1", ["answer", "A1", "again"])).rejects.toThrow(/already answered/);
  });

  it("the Supervisor's message to a Peer is copied to its Lead", async () => {
    const w = await started();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    await w.as("sup", ["message", "L1-T1", "keep it small"]);
    expect((await w.inbox("L1-T1")).at(-1)).toContain("keep it small");
    expect((await w.inbox("L1")).at(-1)).toMatch(/Copy: the Supervisor wrote to L1-T1/);
  });
});

describe("stop", () => {
  it("refuses with open lanes unless forced, then closes every seat", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await expect(w.slp(["stop"])).rejects.toThrow(/Open lanes: L1/);
    expect(await w.slp(["stop", "--force"])).toBe(0);
    const s = await w.state();
    expect([...s.seats.values()].every((x) => !x.live)).toBe(true);
    expect(w.out.at(-1)).toContain("lanes still open: L1");
  });
});
