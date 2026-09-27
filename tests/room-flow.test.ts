import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as cmd from "../src/commands.js";
import { foldCases } from "../src/cases.js";
import { acquireLock, appendEvent, readEvents } from "../src/log.js";
import { Herdr } from "../src/herdr.js";
import { DEFAULT_WATCH } from "../src/watch.js";
import { watchTick } from "../src/watcher.js";
import { loadRoom } from "../src/room.js";
import { deps, FakeHerdrCli, sandboxed, tempHome } from "./helpers.js";

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
    expect(leadStart.slice(leadStart.indexOf("--"))).toEqual(["--", "--allowedTools", "Bash(spl *)", "Bash(spl.cmd *)"]);
    const peerStart = cli.calls.find((c) => c[1] === "start" && c[2] === "demo-p1")!;
    expect(peerStart.slice(peerStart.indexOf("--"))).toEqual(["--", "--no-daemon", "--sandbox", "workspace-write", "--add-dir", home]);
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

describe("startup dialogs", () => {
  it("never sends the onboarding prompt into a folder-trust dialog Herdr reports as ready", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    cli.screens.set("demo-p1", "Folder access\n  Trust this folder? Codex can read, edit, and run files here\n› 1. Trust and continue");
    const out: string[] = [];
    await cmd.up(deps(home, undefined, cli, out), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    expect(cli.prompts.map((p) => p.target)).toEqual(["demo-lead"]);
    expect(out.join("\n")).toMatch(/p1: NEEDS ATTENTION[^\n]*trust/i);
  });
});

describe("busy panes", () => {
  it("retries a pane whose shell is not ready yet", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    cli.busyStarts.set("w9:p1", 2); // the root shell is still starting
    const created = await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    expect(created.members.lead!.paneId).toBe("w9:p1");
    expect(cli.prompts.map((p) => p.target)).toEqual(["demo-lead", "demo-p1"]);
  });

  it("moves a member to a fresh pane when its pane stays occupied, and records it", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    cli.busyStarts.set("w9:p1", 1_000); // e.g. a stray process owns the root pane
    const out: string[] = [];
    const created = await cmd.up(deps(home, undefined, cli, out), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    expect(created.members.lead!.paneId).toBe("w9:p3");
    expect((await loadRoom({ SPL_HOME: home }, "demo"))!.members.lead!.paneId).toBe("w9:p3");
    expect(cli.prompts.map((p) => p.target)).toEqual(["demo-lead", "demo-p1"]);
    expect(out.join("\n")).toMatch(/lead: pane w9:p1 is occupied; using w9:p3/);
  });
});

describe("sandboxed senders and the room watcher", () => {
  async function roomWithWatcher(watching: boolean) {
    const r = await room();
    for (const m of Object.values(r.created.members)) r.cli.agents.set(m.paneId, { status: "idle", seq: 1, kind: m.kind });
    if (watching) await acquireLock(join(r.home, "rooms", "demo", "watch.lock")); // a live watcher
    await cmd.send(r.as("lead"), undefined, "p1", "brief");
    return r;
  }

  it("queues a message the sender cannot hand to Herdr, and the watcher relays it", async () => {
    const { home, cli, created } = await roomWithWatcher(true);
    const out: string[] = [];
    const event = await cmd.handback(sandboxed(home, created.members.p1!.paneId, out), undefined, "c1", "done, evidence attached");
    // Seen live: the raw "Access is denied" made a Codex peer think delivery
    // failed and ask to redeliver. The sender must read this as success.
    expect(out.join("\n")).toMatch(/recorded; the room watcher will deliver it within seconds\. Nothing else to do\./);
    expect(out.join("\n")).not.toMatch(/denied|fail/i);
    let view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect(view.queued).toEqual([event.seq]);
    cli.prompts = [];
    await watchTick({ env: { SPL_HOME: home }, herdr: new Herdr(cli.exec, "herdr"), out: () => undefined }, created, DEFAULT_WATCH);
    expect(cli.prompts.map((p) => p.target)).toEqual([created.members.lead!.paneId]);
    expect(cli.prompts[0]!.text).toMatch(/^\[SPL handback c1 from p1\]/);
    view = foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!;
    expect([view.queued, view.undelivered]).toEqual([[], []]);
  });

  it("fails loudly, naming `spl watch`, when no watcher can relay", async () => {
    const { home, created } = await roomWithWatcher(false);
    await expect(cmd.handback(sandboxed(home, created.members.p1!.paneId), undefined, "c1", "done"))
      .rejects.toThrow(/cannot reach Herdr.*spl watch/);
  });

  it("does not let the sender redeliver a queued message", async () => {
    const { home, created } = await roomWithWatcher(true);
    const event = await cmd.handback(sandboxed(home, created.members.p1!.paneId), undefined, "c1", "done");
    await expect(cmd.redeliver(sandboxed(home, created.members.p1!.paneId), undefined, event.seq, false)).rejects.toThrow(/queued/);
  });
});

describe("confirming submission", () => {
  it("presses Enter when the target left the message as unsent pasted text", async () => {
    const { cli, created, as } = await room();
    for (const m of Object.values(created.members)) cli.agents.set(m.paneId, { status: "idle", seq: 1, kind: m.kind });
    cli.swallowEnter.add(created.members.p1!.paneId);
    await cmd.send(as("lead"), undefined, "p1", "a long brief");
    expect(cli.keys).toEqual([{ target: created.members.p1!.paneId, keys: ["enter"] }]);
    expect(cli.agents.get(created.members.p1!.paneId)!.status).toBe("working");
  });

  it("presses nothing when the target started working", async () => {
    const { cli, created, as } = await room();
    for (const m of Object.values(created.members)) cli.agents.set(m.paneId, { status: "idle", seq: 1, kind: m.kind });
    await cmd.send(as("lead"), undefined, "p1", "brief");
    expect(cli.keys).toEqual([]);
  });
});

describe("round-5 delivery fixes", () => {
  async function started() {
    const r = await room();
    for (const m of Object.values(r.created.members)) r.cli.agents.set(m.paneId, { status: "idle", seq: 1, kind: m.kind });
    return r;
  }

  it("still checks submission when the target was working a moment before", async () => {
    const { cli, created, as } = await started();
    cli.agents.get(created.members.p1!.paneId)!.status = "working";
    cli.swallowEnter.add(created.members.p1!.paneId);
    await cmd.send(as("lead"), undefined, "p1", "brief");
    expect(cli.keys).toEqual([{ target: created.members.p1!.paneId, keys: ["enter"] }]);
  });

  it("ignores a [Pasted text marker that is only in the scrollback, not the input line", async () => {
    const { cli, created, as } = await started();
    const pane = created.members.p1!.paneId;
    cli.swallowEnter.add(pane);
    cli.scrollback.set(pane, "> [Pasted text #7 +3 lines]\n" + "output line\n".repeat(20));
    cli.exec = ((inner) => async (file: string, args: readonly string[]) => {
      // After the prompt the input line is empty: only the old marker remains, far above.
      if (args[0] === "agent" && args[1] === "read") return { code: 0, stdout: cli.scrollback.get(pane)! + "> ", stderr: "" };
      return inner(file, args);
    })(cli.exec);
    await cmd.send({ ...as("lead"), herdr: new Herdr(cli.exec, "herdr") }, undefined, "p1", "brief");
    expect(cli.keys).toEqual([]);
  });

  it("lets the watcher relay a forced resend queued after an earlier delivery", async () => {
    const { home, cli, created, as } = await started();
    const brief = await cmd.send(as("lead"), undefined, "p1", "brief");
    await acquireLock(join(home, "rooms", "demo", "watch.lock"));
    await cmd.redeliver(sandboxed(home, created.members.lead!.paneId), undefined, brief.seq, true);
    expect(foldCases(await readEvents({ SPL_HOME: home }, "demo")).get("c1")!.queued).toEqual([brief.seq]);
    cli.prompts = [];
    await watchTick({ env: { SPL_HOME: home }, herdr: new Herdr(cli.exec, "herdr"), out: () => undefined }, created, DEFAULT_WATCH);
    expect(cli.prompts.map((p) => p.target)).toEqual([created.members.p1!.paneId]);
  });

  it("refuses even a forced redeliver while the watcher is relaying the message", async () => {
    const { home, as } = await started();
    const brief = await cmd.send(as("lead"), undefined, "p1", "brief");
    await appendEvent({ SPL_HOME: home }, "demo", () => ({ kind: "delivery" as const, ref: brief.seq, ok: false, error: "relaying", stage: "relaying" as const }));
    await expect(cmd.redeliver(as("lead"), undefined, brief.seq, true)).rejects.toThrow(/being relayed/);
  });
});
