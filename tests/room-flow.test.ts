import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as cmd from "../src/commands.js";
import { foldCases } from "../src/cases.js";
import { appendEvent, readEvents } from "../src/log.js";
import { deps, FakeHerdrCli, tempHome } from "./helpers.js";

async function room(opts: Partial<cmd.UpOptions> = {}) {
  const home = await tempHome();
  const cli = new FakeHerdrCli();
  const out: string[] = [];
  const created = await cmd.up(deps(home, undefined, cli, out), {
    room: "demo", cwd: home, lead: "claude", peers: ["codex", "codex"], supervisor: "claude", ...opts,
  });
  const as = (name: string) => deps(home, created.members[name]!.paneId, cli, out);
  return { home, cli, out, created, as };
}

describe("spl up", () => {
  it("creates a workspace, one pane per member, starts and onboards every agent", async () => {
    const { cli, created, home } = await room();
    expect(Object.keys(created.members)).toEqual(["lead", "p1", "p2", "sup"]);
    expect(new Set(Object.values(created.members).map((m) => m.paneId)).size).toBe(4);
    const starts = cli.calls.filter((c) => c[0] === "agent" && c[1] === "start").map((c) => [c[2], c[4]]);
    expect(starts).toEqual([["demo-lead", "claude"], ["demo-p1", "codex"], ["demo-p2", "codex"], ["demo-sup", "claude"]]);
    // Agents must be able to run `spl` without an approval dialog.
    const leadStart = cli.calls.find((c) => c[1] === "start" && c[2] === "demo-lead")!;
    expect(leadStart.slice(leadStart.indexOf("--"))).toEqual(["--", "--allowedTools", "Bash(spl *)"]);
    const peerStart = cli.calls.find((c) => c[1] === "start" && c[2] === "demo-p1")!;
    expect(peerStart.slice(peerStart.indexOf("--"))).toEqual(["--", "--add-dir", home]);
    expect(cli.prompts.map((p) => p.target)).toEqual(["demo-lead", "demo-p1", "demo-p2", "demo-sup"]);
    expect(cli.prompts[1]!.text).toContain('You are "p1", the peer of SPL room "demo"');
    const splits = cli.calls.filter((c) => c[1] === "split");
    expect(splits.every((c) => c.includes("--no-focus"))).toBe(true);
    expect(splits[0]).toContain("SPL_ROOM=demo");
  });

  it("keeps going when an agent is not ready and tells the human what to paste", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    cli.failStartFor.add("demo-p2");
    const out: string[] = [];
    await cmd.up(deps(home, undefined, cli, out), { room: "demo", cwd: home, lead: "claude", peers: ["codex", "codex"], supervisor: null });
    expect(out.join("\n")).toMatch(/p2: NEEDS ATTENTION[\s\S]*You are "p2"/);
    expect(cli.prompts.map((p) => p.target)).toEqual(["demo-lead", "demo-p1"]);
  });

  it("reserves the room name before touching Herdr, and releases it if setup fails early", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    const opts = { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null };
    await mkdir(join(home, "rooms", "demo"), { recursive: true }); // another `spl up demo` in progress
    await expect(cmd.up(deps(home, undefined, cli), opts)).rejects.toThrow(/being created/);
    expect(cli.calls).toEqual([]);

    await rm(join(home, "rooms", "demo"), { recursive: true });
    const failing = new FakeHerdrCli();
    failing.exec = async () => ({ code: 1, stdout: "", stderr: '{"error":{"code":"server_down","message":"no server"}}' });
    await expect(cmd.up(deps(home, undefined, failing), opts)).rejects.toThrow(/server_down|no server/);
    await cmd.up(deps(home, undefined, cli), opts); // name is free again
  });

  it("refuses to reuse a room name and rejects invalid names", async () => {
    const { home, cli } = await room();
    await expect(cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null })).rejects.toThrow(/already exists/);
    await expect(cmd.up(deps(home, undefined, cli), { room: "Bad Name", cwd: home, lead: "claude", peers: ["codex"], supervisor: null })).rejects.toThrow(/Invalid room name/);
  });
});

describe("brief / handback / reply", () => {
  it("runs a full case and delivers each message by pane with an envelope", async () => {
    const { home, cli, created, as } = await room();
    cli.prompts = [];
    const brief = await cmd.send(as("lead"), undefined, "p1", "Fix login. Scope: src/auth only. Evidence: npm test.");
    expect(brief.case).toBe("c1");
    await cmd.handback(as("p1"), undefined, "c1", "Done: changed src/auth/login.ts; npm test passed.");
    await cmd.reply(as("lead"), undefined, "c1", "p2", "Please review src/auth/login.ts against c1.");

    expect(cli.prompts.map((p) => p.target)).toEqual([created.members.p1!.paneId, created.members.lead!.paneId, created.members.p2!.paneId]);
    expect(cli.prompts[0]!.text).toMatch(/^\[SPL brief c1 from lead\]/);
    expect(cli.prompts[0]!.text).toContain("spl handback c1");
    expect(cli.prompts[1]!.text).toContain("spl reply c1 <peer>");

    const view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect(view.messages.map((m) => m.kind)).toEqual(["brief", "handback", "reply"]);
    expect(view.state).toBe("lead-replied");
    expect(view.undelivered).toEqual([]);
  });

  it("lets a peer that the lead addressed on a case (e.g. a reviewer) hand back on it", async () => {
    const { as } = await room();
    await cmd.send(as("lead"), undefined, "p1", "implement");
    await cmd.handback(as("p1"), undefined, "c1", "implemented");
    await expect(cmd.handback(as("p2"), undefined, "c1", "not addressed yet")).rejects.toThrow(/not addressed to p2/);
    await cmd.reply(as("lead"), undefined, "c1", "p2", "review it");
    const review = await cmd.handback(as("p2"), undefined, "c1", "review findings");
    expect(review.to).toBe("lead");
  });

  it("numbers cases per brief", async () => {
    const { as } = await room();
    expect((await cmd.send(as("lead"), undefined, "p1", "a")).case).toBe("c1");
    expect((await cmd.send(as("lead"), undefined, "p2", "b")).case).toBe("c2");
  });

  it("enforces roles and case ownership", async () => {
    const { as } = await room();
    await expect(cmd.send(as("p1"), undefined, "p2", "x")).rejects.toThrow(/Only the lead can send/);
    await expect(cmd.send(as("lead"), undefined, "sup", "x")).rejects.toThrow(/not a peer/);
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await expect(cmd.handback(as("p2"), undefined, "c1", "x")).rejects.toThrow(/not addressed to p2/);
    await expect(cmd.handback(as("p1"), undefined, "c9", "x")).rejects.toThrow(/Unknown case c9/);
    await expect(cmd.handback(as("p1"), undefined, "c1", "   ")).rejects.toThrow(/empty/);
    await expect(cmd.reply(as("sup"), undefined, "c1", "p1", "x")).rejects.toThrow(/Only the lead/);
  });

  it("rejects callers outside any room", async () => {
    const { home, cli } = await room();
    await expect(cmd.send(deps(home, "w1:p77", cli), undefined, "p1", "x")).rejects.toThrow(/not a member/);
  });

  it("derives identity from the pane only: SPL_AGENT cannot claim another member", async () => {
    const { home, cli } = await room();
    const forged = { ...deps(home, "w9:p77", cli), env: { SPL_HOME: home, HERDR_PANE_ID: "w9:p77", SPL_ROOM: "demo", SPL_AGENT: "lead" } };
    await expect(cmd.send(forged, undefined, "p1", "x")).rejects.toThrow(/not a member/);
  });

  it("requires the pane to be in the room's workspace when Herdr reports one", async () => {
    const { home, cli, created } = await room();
    const elsewhere = { ...deps(home, created.members.lead!.paneId, cli), env: { SPL_HOME: home, HERDR_PANE_ID: created.members.lead!.paneId, HERDR_WORKSPACE_ID: "w1" } };
    await expect(cmd.send(elsewhere, undefined, "p1", "x")).rejects.toThrow(/not a member/);
  });

  it("records an undelivered message and lets its sender redeliver it", async () => {
    const { home, cli, created, as } = await room();
    cli.failPromptFor.add(created.members.p1!.paneId);
    await expect(cmd.send(as("lead"), undefined, "p1", "brief")).rejects.toThrow(/recorded as seq 1 but NOT delivered.*spl redeliver 1/);
    let view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect(view.undelivered).toEqual([1]);

    await expect(cmd.redeliver(as("p1"), undefined, 1, false)).rejects.toThrow(/only its sender/);
    cli.failPromptFor.clear();
    await cmd.redeliver(as("lead"), undefined, 1, false);
    view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect(view.undelivered).toEqual([]);
    // Delivered now: a second redeliver would duplicate it.
    await expect(cmd.redeliver(as("lead"), undefined, 1, false)).rejects.toThrow(/already delivered/);
  });

  it("refuses to blindly redeliver a message whose delivery outcome is unknown", async () => {
    const { home, cli, as, out } = await room();
    // The sender crashed after Herdr accepted the prompt but before recording it.
    await appendEvent({ SPL_HOME: home }, "demo", () => ({ kind: "brief" as const, case: "c1", from: "lead", to: "p1", text: "brief" }));
    const view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect([view.failed, view.unconfirmed]).toEqual([[], [1]]);
    out.length = 0;
    await cmd.status(as("lead"), undefined);
    expect(out.join("\n")).toContain("UNCONFIRMED seq 1");
    await expect(cmd.redeliver(as("lead"), undefined, 1, false)).rejects.toThrow(/outcome is unknown.*--force/);
    cli.prompts = [];
    await cmd.redeliver(as("lead"), undefined, 1, true);
    expect(cli.prompts).toHaveLength(1);
  });

  it("moves long messages to a file and points the target at it", async () => {
    const { cli, as } = await room();
    cli.prompts = [];
    const long = "x".repeat(cmd.INLINE_LIMIT + 1);
    await cmd.send(as("lead"), undefined, "p1", long);
    const text = cli.prompts[0]!.text;
    expect(text).not.toContain(long);
    const file = text.split("\n").find((l) => l.endsWith("-brief-c1.md"))!;
    expect(await readFile(file, "utf8")).toBe(long);
  });
});

describe("views", () => {
  it("status lists members and case state; log prints the case history", async () => {
    const { as, out } = await room();
    await cmd.send(as("lead"), undefined, "p1", "the brief");
    out.length = 0;
    await cmd.status(as("sup"), undefined);
    expect(out.join("\n")).toMatch(/c1\s+lead -> p1\s+awaiting-handback/);
    out.length = 0;
    await cmd.log(as("sup"), undefined, "c1");
    expect(out.join("\n")).toMatch(/seq 1 brief lead -> p1[\s\S]*the brief/);
  });
});

describe("closing a case", () => {
  it("delivers a closing reply that asks for nothing and marks the case closed", async () => {
    const { home, cli, as, out } = await room();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    cli.prompts = [];
    const closing = await cmd.reply(as("lead"), undefined, "c1", "p1", "Accepted.", true);
    expect(closing).toMatchObject({ kind: "reply", closes: true });
    expect(cli.prompts[0]!.text).toMatch(/^\[SPL reply c1 from lead, case closed\]/);
    expect(cli.prompts[0]!.text).toContain("No handback is needed");
    expect(cli.prompts[0]!.text).not.toContain("spl handback c1");
    expect(foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!.state).toBe("closed");
    out.length = 0;
    await cmd.status(as("sup"), undefined);
    expect(out.join("\n")).toMatch(/c1\s+lead -> p1\s+closed/);
  });
});
