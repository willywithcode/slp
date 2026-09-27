import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { stepFacts, stuckFact, unverifiedFact } from "../src/watch/facts.js";
import { observeTiming } from "../src/watch/observer.js";
import { claudeSteps, codexSteps, parsePatch, TranscriptTail } from "../src/watch/transcripts.js";
import { Watcher } from "../src/watcher.js";
import { tempDir, World } from "./helpers.js";

observeTiming.lookupMs = 0;
observeTiming.screenMs = 0;

const T = "2026-09-27T10:00:00.000Z";

// Lines shaped like the real transcripts (Claude Code 2.1, Codex 0.157).
const claude = {
  bash: (command: string) => ({ type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } }),
  edit: (file: string, old_string: string, new_string: string) => ({ type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: file, old_string, new_string } }] } }),
  result: (text: string, is_error = false, id = "t1") => ({ type: "user", timestamp: T, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] } }),
  apiError: (text: string) => ({ type: "assistant", timestamp: T, isApiErrorMessage: true, message: { content: [{ type: "text", text }] } }),
};
const codex = {
  meta: (roots: string[]) => ({ timestamp: T, type: "session_meta", payload: { id: "s1", cwd: roots[0], runtime_workspace_roots: roots } }),
  exec: (cmd: string, at = T) => ({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:"C:\\\\x",yield_time_ms:10000});` } }),
  patch: (patch: string) => ({ timestamp: T, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: `const patch = ${JSON.stringify(patch)};\nawait tools.apply_patch(patch);` } }),
  error: (message: string) => ({ timestamp: T, type: "event_msg", payload: { type: "error", message } }),
};
const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("transcript readers", () => {
  it("reads Claude Code steps", () => {
    expect(claudeSteps(claude.bash("npm test"))).toEqual([{ at: T, kind: "command", text: "npm test", ref: "t1" }]);
    expect(claudeSteps(claude.edit("/r/a.ts", "x\ny", "z"))[0]).toMatchObject({ kind: "edit", files: ["/r/a.ts"], removed: ["x", "y"], added: ["z"] });
    expect(claudeSteps(claude.result("boom", true))[0]).toMatchObject({ kind: "result", failed: true });
    expect(claudeSteps(claude.apiError("You've hit your limit · resets 3pm"))[0]).toMatchObject({ kind: "error" });
    expect(claudeSteps({ type: "attachment" })).toEqual([]);
  });

  it("reads Codex code-mode calls and patches", () => {
    expect(codexSteps(codex.exec("git status --short"))).toEqual([{ at: T, kind: "command", text: "git status --short" }]);
    const patch = "*** Begin Patch\n*** Update File: C:\\r\\test\\a.test.js\n@@\n-  assert.equal(add(2, 3), 5);\n+  // later\n*** End Patch";
    expect(codexSteps(codex.patch(patch))[0]).toMatchObject({ kind: "edit", files: ["C:\\r\\test\\a.test.js"], removed: ["  assert.equal(add(2, 3), 5);"] });
    expect(parsePatch("*** Add File: x.js\n+a\n")).toEqual({ files: ["x.js"], removed: [], added: ["a"] });
    expect(codexSteps(codex.error("You've hit your usage limit."))[0]).toMatchObject({ kind: "error" });
  });

  it("tails a transcript as it grows, across a split line", async () => {
    const dir = await tempDir();
    const path = join(dir, "t.jsonl");
    const line = JSON.stringify(claude.bash("echo héllo"));
    await writeFile(path, `${JSON.stringify(claude.bash("one"))}\n${line.slice(0, 20)}`);
    const tail = new TranscriptTail(path, claudeSteps);
    expect((await tail.next()).map((s) => s.text)).toEqual(["one"]);
    await appendFile(path, `${line.slice(20)}\n`);
    expect((await tail.next()).map((s) => s.text)).toEqual(["echo héllo"]);
    expect(await tail.next()).toEqual([]);
  });
});

describe("facts", () => {
  const ctx = { owned: ["src/greet/**"], workdir: "/r" };

  it("pages on destructive commands", () => {
    for (const c of ["rm -rf build", "git reset --hard HEAD~1", "git push --force origin main", "Remove-Item -Recurse -Force .\\src", "git clean -fdx"]) {
      expect(stepFacts(codexSteps(codex.exec(c)), ctx).map((f) => f.fact)).toContain("destructive");
    }
    for (const c of ["rm file.txt", "git reset HEAD~1", "git push origin lane", "npm test"]) {
      expect(stepFacts(codexSteps(codex.exec(c)), ctx).map((f) => f.fact)).not.toContain("destructive");
    }
  });

  it("finds weakened tests, suppressions and edits outside owned paths", () => {
    const weakened = stepFacts(claudeSteps(claude.edit("/r/src/greet/greet.test.js", "  expect(greet('a')).toBe('hello, a');", "")), ctx);
    expect(weakened.map((f) => f.fact)).toEqual(["test_weakened"]);
    const skipped = stepFacts(claudeSteps(claude.edit("/r/src/greet/greet.test.js", "it('x', () => {", "it.skip('x', () => {")), ctx);
    expect(skipped.map((f) => f.fact)).toEqual(["test_weakened"]);
    const suppressed = stepFacts(claudeSteps(claude.edit("/r/src/greet/greet.ts", "const x = f();", "// @ts-ignore\nconst x = f();")), ctx);
    expect(suppressed.map((f) => f.fact)).toEqual(["suppression"]);
    const outside = stepFacts(claudeSteps(claude.edit("/r/src/other.ts", "a", "b")), ctx);
    expect(outside.map((f) => f.fact)).toEqual(["outside_owned"]);
    // Files outside the working copy (scratch notes) are not the project's.
    expect(stepFacts(claudeSteps(claude.edit("/tmp/notes.md", "a", "b")), ctx)).toEqual([]);
    // Moving an assertion is not weakening it.
    expect(stepFacts(claudeSteps(claude.edit("/r/src/greet/greet.test.js", "expect(a).toBe(1);", "expect(a).toBe(1); // same")), ctx)).toEqual([]);
  });

  it("names account problems only from the agent's own errors", () => {
    expect(stepFacts(codexSteps(codex.error("You've hit your usage limit. Upgrade to Pro")), ctx).map((f) => f.fact)).toEqual(["usage_limit"]);
    expect(stepFacts(claudeSteps(claude.apiError("Please run /login · API Error: 401")), ctx).map((f) => f.fact)).toEqual(["auth_failed"]);
    // A tool's output about some API's rate limit is not the seat's account.
    expect(stepFacts(claudeSteps(claude.result("GitHub API rate limit exceeded", true)), ctx)).toEqual([]);
  });

  it("sees a seat repeating itself, and completion claimed without tests", () => {
    const steps = ["npm test", "npm test", "ls", "npm test"].flatMap((c) => codexSteps(codex.exec(c)));
    expect(stuckFact(steps)?.fact).toBe("stuck");
    expect(stuckFact(steps.slice(0, 2))).toBeNull();
    const edit = claudeSteps(claude.edit("/r/src/greet/a.js", "a", "b"));
    expect(unverifiedFact([...codexSteps(codex.exec("npm test")), ...edit], "L1-T1")?.fact).toBe("unverified");
    expect(unverifiedFact([...edit, ...codexSteps(codex.exec("npm.cmd test"))], "L1-T1")).toBeNull();
  });
});

describe("the watch", () => {
  const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];

  async function withPeer(mail: boolean): Promise<World> {
    const w = await World.create();
    const config = defaultConfig("linux");
    config.watch.mail = mail;
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    return w;
  }

  async function rollout(w: World, lines: object[]): Promise<string> {
    const peer = (await w.state()).seats.get("L1-T1")!;
    const d = new Date();
    const dir = join(w.home, "codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, "rollout-test.jsonl");
    await writeFile(path, jsonl([codex.meta([w.repo, peer.marker!]), ...lines]));
    return path;
  }

  it("records incidents in shadow: the Human hears pages, no seat is mailed", async () => {
    const w = await withPeer(false);
    await rollout(w, [codex.exec("git reset --hard HEAD~3"), codex.exec("npm test")]);
    await new Watcher(w.deps(null), w.project).tick();
    const s = await w.state();
    expect(s.incidents.map((i) => [i.seat, i.fact, i.level, i.to])).toEqual([["L1-T1", "destructive", "page", "sup"]]);
    expect(w.cli.notifications.some((n) => n.title.includes("L1-T1 needs a look"))).toBe(true);
    expect(s.letters.some((l) => l.letter === "INCIDENT")).toBe(false);
    // Seen once, raised once.
    await new Watcher(w.deps(null), w.project).tick();
    expect((await w.state()).incidents).toHaveLength(1);
  });

  it("with mail on, routes a Peer's incident to its Lead; the Peer never hears", async () => {
    const w = await withPeer(true);
    const peerPane = await w.pane("L1-T1");
    const before = w.cli.promptsTo(peerPane).length;
    await rollout(w, [codex.patch("*** Begin Patch\n*** Update File: src/a/a.test.js\n-  expect(a()).toBe(1);\n*** End Patch")]);
    await new Watcher(w.deps(null), w.project).tick();
    const incident = (await w.state()).incidents[0]!;
    expect(incident).toMatchObject({ fact: "test_weakened", to: "L1" });
    expect((await w.inbox("L1")).at(-1)).toMatch(/\[SLP INCIDENT[\s\S]*I1 \[attend\] L1-T1 removed 1 assertion[\s\S]*slp ack I1/);
    expect(w.cli.promptsTo(peerPane).length).toBe(before);
    w.cli.idleAll();
    expect(await w.as("L1", ["ack", "I1", "useful", "caught it"])).toBe(0);
    expect((await w.state()).acks[0]).toMatchObject({ incident: "I1", verdict: "useful", by: "L1" });
  });

  it("tells the Supervisor when a seat's account runs out, with where to move it", async () => {
    const w = await World.create();
    const config = defaultConfig("linux");
    config.launchers["codex-b"] = { agent: "codex", env: { CODEX_HOME: "{home}/.codex-b" }, prep: {} };
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    await rollout(w, [codex.error("You've hit your usage limit. Try again later.")]);
    await new Watcher(w.deps(null), w.project).tick();
    expect((await w.inbox("sup")).at(-1)).toMatch(/L1-T1 \(codex\) its account hit a usage limit[\s\S]*slp move-seat L1-T1 codex-b/);
  });

  it("notes a Lead that writes code itself, from its Claude transcript", async () => {
    const w = await withPeer(true);
    const lead = (await w.state()).seats.get("L1")!;
    const dir = join(w.home, "claude", "projects", "some-project");
    await mkdir(dir, { recursive: true });
    // A refused edit changed nothing: no incident.
    await writeFile(join(dir, `${lead.sessionId}.jsonl`), jsonl([claude.edit(join(w.repo, "src", "a", "x.js"), "a", "b"), claude.result("denied", true, "t2")]));
    const watcher = new Watcher(w.deps(null), w.project);
    await watcher.tick();
    expect((await w.state()).incidents).toEqual([]);
    await appendFile(join(dir, `${lead.sessionId}.jsonl`), jsonl([claude.edit(join(w.repo, "src", "a", "x.js"), "a", "b"), claude.result("ok", false, "t2")]));
    await watcher.tick();
    expect((await w.state()).incidents.map((i) => [i.seat, i.fact, i.to])).toEqual([["L1", "lead_wrote", "sup"]]);
  });

  it("flags a complete hand-back with edits after the last test run", async () => {
    const w = await withPeer(true);
    await rollout(w, [codex.exec("npm test"), codex.patch("*** Begin Patch\n*** Update File: src/a/a.js\n+x\n*** End Patch")]);
    const watcher = new Watcher(w.deps(null), w.project);
    await watcher.tick();
    await w.as("L1-T1", ["done", "complete", "--check", "npm test: ok", "done"]);
    await watcher.tick();
    const facts = (await w.state()).incidents.map((i) => i.fact);
    expect(facts).toContain("unverified");
  });
});

describe("moving a seat to another account", () => {
  const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];

  async function world(): Promise<World> {
    const w = await World.create();
    const config = defaultConfig("linux");
    config.launchers["claude-b"] = { agent: "claude", env: { ANTHROPIC_API_KEY: null }, prep: {} };
    config.launchers["codex-b"] = { agent: "codex", env: { CODEX_HOME: "{home}/.codex-b" }, prep: {} };
    await writeFile(join(w.home, "config.json"), JSON.stringify(config));
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    w.cli.idleAll();
    return w;
  }

  it("resumes a Claude seat's session on the other account", async () => {
    const w = await world();
    const before = (await w.state()).seats.get("L1")!;
    expect(await w.as("sup", ["move-seat", "L1", "claude-b"])).toBe(0);
    const after = (await w.state()).seats.get("L1")!;
    expect(after).toMatchObject({ launcher: "claude-b", sessionId: before.sessionId, live: true });
    expect(after.paneId).not.toBe(before.paneId);
    expect(w.cli.closedPanes).toContain(before.paneId);
    const start = w.cli.calls.filter((c) => c[0] === "agent" && c[1] === "start").at(-1)!;
    expect(start).toEqual(expect.arrayContaining(["--resume", before.sessionId!]));
    expect(start).not.toContain("--session-id");
    expect(w.cli.ran.some((r) => r.pane === after.paneId && r.command.includes("unset ANTHROPIC_API_KEY"))).toBe(true);
    expect((await w.inbox("L1")).at(-1)).toContain("moved to another account (claude-b)");
  });

  it("resumes a Codex seat by the session found through its marker", async () => {
    const w = await world();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    w.cli.idleAll();
    const peer = (await w.state()).seats.get("L1-T1")!;
    const d = new Date();
    const dir = join(w.home, "codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rollout-x.jsonl"), jsonl([{ ...codex.meta([w.repo, peer.marker!]), payload: { id: "0199-session", runtime_workspace_roots: [w.repo, peer.marker!] } }]));
    expect(await w.as("sup", ["move-seat", "L1-T1", "codex-b"])).toBe(0);
    const start = w.cli.calls.filter((c) => c[0] === "agent" && c[1] === "start").at(-1)!;
    expect(start.slice(start.indexOf("--") + 1, start.indexOf("--") + 3)).toEqual(["resume", "0199-session"]);
    expect((await w.state()).seats.get("L1-T1")!.launcher).toBe("codex-b");
  });

  it("refuses moves that cannot work", async () => {
    const w = await world();
    await expect(w.as("sup", ["move-seat", "L1", "codex-b"])).rejects.toThrow(/only move within one agent/);
    await expect(w.as("sup", ["move-seat", "L1", "nope"])).rejects.toThrow(/No launcher "nope"/);
    await expect(w.as("sup", ["move-seat", "sup", "claude-b"])).rejects.toThrow(/Supervisor's own seat/);
    w.cli.agents.get(await w.pane("L1"))!.status = "working";
    await expect(w.as("sup", ["move-seat", "L1", "claude-b"])).rejects.toThrow(/is working/);
    await expect(w.as("L1", ["move-seat", "L1", "claude-b"])).rejects.toThrow(/lead does not run/);
  });
});

describe("the Critic hears the Human, not a summary", () => {
  it("takes the Human's own words from the Supervisor's transcript", async () => {
    const w = await World.create();
    await w.slp(["start"]);
    w.cli.idleAll();
    const sup = (await w.state()).seats.get("sup")!;
    const dir = join(w.home, "claude", "projects", "p");
    await mkdir(dir, { recursive: true });
    const later = new Date(Date.now() + 1000).toISOString();
    await writeFile(join(dir, `${sup.sessionId}.jsonl`), jsonl([
      { type: "user", timestamp: later, message: { content: "[SLP INTRO #4 from slp]\n\nYou are sup" } },
      { type: "user", timestamp: later, message: { content: "greet people by name, and never shout" } },
      { type: "user", timestamp: later, isMeta: true, message: { content: "<local-command-stdout>x</local-command-stdout>" } },
      claude.result("tool output"),
    ]));
    await w.as("sup", ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"]);
    const s = await w.state();
    expect(s.lanes.get("L1")!.humanWords).toBe("greet people by name, and never shout");
    const first = (await w.inbox("L1-critic"))[0]!;
    expect(first).toContain("never shout");
    expect(first).not.toContain("You are sup");
  });
});
