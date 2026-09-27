import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as cmd from "../src/commands.js";
import { acquireLock, appendEvent, readEvents, releaseLock } from "../src/log.js";
import { listRooms } from "../src/room.js";
import { deps, FakeHerdrCli, tempHome } from "./helpers.js";

async function room(watch = false) {
  const home = await tempHome();
  const cli = new FakeHerdrCli();
  const created = await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: "claude", watch });
  return { home, cli, created };
}

describe("slp down", () => {
  it("closes the room's workspace and archives its data", async () => {
    const { home, cli, created } = await room();
    await cmd.down(deps(home, "w1:p1", cli), "demo", false);
    expect(cli.calls.filter((c) => c[0] === "workspace" && c[1] === "close")).toEqual([["workspace", "close", created.workspaceId]]);
    expect(await listRooms({ SLP_HOME: home })).toEqual([]);
    const archived = await readdir(join(home, "rooms", ".archive"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^demo-/);
  });

  it("refuses to run from inside the room it would close", async () => {
    const { home, cli, created } = await room();
    await expect(cmd.down(deps(home, created.members.p1!.paneId, cli), "demo", false)).rejects.toThrow(/from inside room demo/);
    expect(cli.calls.some((c) => c[1] === "close")).toBe(false);
  });

  it("keeps the room when Herdr cannot close it, unless forced", async () => {
    const { home, cli } = await room();
    cli.failWorkspaceClose = true;
    await expect(cmd.down(deps(home, "w1:p1", cli), "demo", false)).rejects.toThrow(/--force/);
    expect(await listRooms({ SLP_HOME: home })).toEqual(["demo"]);
    await cmd.down(deps(home, "w1:p1", cli), "demo", true);
    expect(await listRooms({ SLP_HOME: home })).toEqual([]);
  });

  it("frees the name for a new room", async () => {
    const { home, cli } = await room();
    await cmd.down(deps(home, "w1:p1", cli), "demo", false);
    await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    expect(await listRooms({ SLP_HOME: home })).toEqual(["demo"]);
  });
});

describe("slp up --watch", () => {
  it("starts the watcher in its own pane of the room workspace", async () => {
    const { cli, created } = await room(true);
    // The fake numbers panes in creation order: lead p1, peer p2, sup p3, watcher p4.
    const split = cli.calls.filter((c) => c[1] === "split").at(-1)!;
    expect(split.slice(0, 5)).toEqual(["pane", "split", created.members.sup!.paneId, "--direction", "down"]);
    expect(split).toContain("--no-focus");
    expect(cli.calls.find((c) => c[0] === "pane" && c[1] === "run")).toEqual(["pane", "run", "w9:p4", "slp watch --room demo"]);
    expect(Object.values(created.members).map((m) => m.paneId)).not.toContain("w9:p4");
  });
});

describe("slp up --watch failure", () => {
  it("keeps the room usable and reports the missing watcher instead of failing", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    cli.failPaneRun = true;
    const out: string[] = [];
    const created = await cmd.up(deps(home, undefined, cli, out), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null, watch: true });
    expect(Object.keys(created.members)).toEqual(["lead", "p1"]);
    expect(out.join("\n")).toMatch(/watch: NEEDS ATTENTION/);
  });
});

describe("room identity under the log lock", () => {
  it("refuses to append on behalf of a room instance that was replaced", async () => {
    const { home, cli, created } = await room();
    await cmd.down(deps(home, "w1:p1", cli), "demo", false);
    await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    const write = () => appendEvent({ SLP_HOME: home }, "demo", () => ({ kind: "brief" as const, case: "c1", from: "lead", to: "p1", text: "stale" }), created);
    await expect(write()).rejects.toThrow(/replaced/);
    expect(await readEvents({ SLP_HOME: home }, "demo")).toEqual([]);
  });
});

describe("slp down and the log lock", () => {
  it("waits for an in-flight writer's lock and leaves no lock in the archive", async () => {
    const { home, cli } = await room();
    const lock = join(home, "rooms", "demo", "events.lock");
    const token = await acquireLock(lock); // a writer mid-append
    await acquireLock(join(home, "rooms", "demo", "watch.lock")); // a watcher killed with its workspace
    let archived = false;
    const downing = cmd.down(deps(home, "w1:p1", cli), "demo", false).then((t) => { archived = true; return t; });
    await new Promise((r) => setTimeout(r, 150));
    expect(archived).toBe(false); // blocked on the writer
    await releaseLock(lock, token);
    const target = await downing;
    expect(await readdir(target)).not.toContain("events.lock");
    expect(await readdir(target)).not.toContain("watch.lock");
  });
});
