import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import * as cmd from "../src/commands.js";
import { Herdr } from "../src/herdr.js";
import { appendEvent, readEvents } from "../src/log.js";
import { listRooms } from "../src/room.js";
import { DEFAULT_WATCH } from "../src/watch.js";
import { watchTick } from "../src/watcher.js";
import { deps, FakeHerdrCli, tempHome } from "./helpers.js";

const MIN = 60_000;

async function setup(supervisor: string | null = "claude") {
  const home = await tempHome();
  const cli = new FakeHerdrCli();
  const room = await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor });
  const clock = { now: Date.parse("2026-09-26T10:00:00Z") };
  const out: string[] = [];
  const d = { herdr: new Herdr(cli.exec, "herdr"), out: (s: string) => { out.push(s); }, now: () => clock.now };
  const pane = (m: string) => room.members[m]!.paneId;
  for (const m of Object.keys(room.members)) cli.agents.set(pane(m), { status: "idle", seq: 1, kind: room.members[m]!.kind });
  const watch = () => main(["watch", "--once", "--room", "demo"], { SPL_HOME: home }, d);
  return { home, cli, room, clock, out, pane, watch };
}

describe("spl watch --once", () => {
  it("raises an alert across runs, delivers it to the supervisor and a notification, and never repeats it", async () => {
    const { home, cli, clock, pane, watch } = await setup();
    await cmd.send(deps(home, pane("lead"), cli), undefined, "p1", "brief");
    cli.prompts = [];

    expect(await watch()).toBe(0); // first observation of p1 idle
    clock.now += 3 * MIN + 1;
    expect(await watch()).toBe(0);
    clock.now += MIN;
    expect(await watch()).toBe(0);

    const alerts = (await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert");
    expect(alerts.map((a) => a.kind === "alert" && a.rule)).toEqual(["peer-idle-without-handback"]);
    expect(cli.prompts.map((p) => p.target)).toEqual([pane("sup")]);
    expect(cli.prompts[0]!.text).toMatch(/^\[SPL alert peer-idle-without-handback c1\]/);
    expect(cli.notifications).toHaveLength(1);
    expect(cli.notifications[0]!.title).toBe("SPL demo: peer-idle-without-handback");
  });

  it("restarts the clock when Herdr reports a new state episode", async () => {
    const { home, cli, clock, pane, watch } = await setup();
    await cmd.send(deps(home, pane("lead"), cli), undefined, "p1", "brief");
    await watch();
    clock.now += 2 * MIN;
    cli.agents.set(pane("p1"), { status: "idle", seq: 2, kind: "codex" }); // worked and settled again
    await watch();
    clock.now += 2 * MIN; // 4 min since the brief, 2 min in the new episode
    await watch();
    expect((await readEvents({ SPL_HOME: home }, "demo")).some((e) => e.kind === "alert")).toBe(false);
  });

  it("notifies only when the room has no supervisor, and reports a vanished agent", async () => {
    const { home, cli, pane, watch } = await setup(null);
    cli.agents.delete(pane("p1"));
    await watch();
    const alerts = (await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert");
    expect(alerts.map((a) => a.kind === "alert" && [a.rule, a.member])).toEqual([["member-gone", "p1"]]);
    expect(cli.prompts.filter((p) => p.text.startsWith("[SPL alert"))).toEqual([]);
    expect(cli.notifications.map((n) => n.title)).toEqual(["SPL demo: member-gone"]);
  });

  it("does not prompt the supervisor about itself", async () => {
    const { home, cli, clock, pane, watch } = await setup();
    cli.agents.set(pane("sup"), { status: "blocked", seq: 4, kind: "claude" });
    await watch();
    clock.now += 3 * MIN + 1;
    await watch();
    expect((await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert")).toHaveLength(1);
    expect(cli.prompts.filter((p) => p.text.startsWith("[SPL alert"))).toEqual([]);
    expect(cli.notifications).toHaveLength(1);
  });
});

describe("spl watch --once: identity and delivery retries", () => {
  it("treats a different agent kind in a member's pane as the member being gone", async () => {
    const { home, cli, pane, watch } = await setup();
    cli.agents.set(pane("p1"), { status: "idle", seq: 1, kind: "opencode" }); // p1 is codex
    await watch();
    const alerts = (await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert");
    expect(alerts.map((a) => a.kind === "alert" && [a.rule, a.member])).toEqual([["member-gone", "p1"]]);
  });

  it("retries an alert until some channel delivers it, then stops", async () => {
    const { home, cli, pane, watch } = await setup();
    cli.failPromptFor.add(pane("sup"));
    cli.failNotifications = true;
    cli.agents.delete(pane("p1"));
    await watch(); // alert recorded, both channels fail
    expect(cli.notifications).toEqual([]);
    cli.failPromptFor.clear();
    cli.failNotifications = false;
    await watch(); // retried
    await watch(); // delivered: no more retries
    expect(cli.prompts.filter((p) => p.text.startsWith("[SPL alert member-gone"))).toHaveLength(1);
    expect(cli.notifications).toHaveLength(1);
    const deliveries = (await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "delivery" && e.channel);
    expect(deliveries.map((e) => e.kind === "delivery" && [e.channel, e.ok])).toEqual([
      ["prompt", false], ["notification", false], ["prompt", true], ["notification", true],
    ]);
  });
});

describe("spl watch --once: round-2 safeguards", () => {
  it("does not trust an agent whose kind Herdr cannot report", async () => {
    const { home, cli, clock, pane, watch } = await setup();
    await cmd.send(deps(home, pane("lead"), cli), undefined, "p1", "brief");
    cli.agents.set(pane("p1"), { status: "idle", seq: 1 }); // no kind
    await watch();
    clock.now += 30 * MIN;
    await watch();
    expect((await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert")).toEqual([]);
  });

  it("allows one watcher per room at a time", async () => {
    const { home, watch } = await setup();
    const lock = join(home, "rooms", "demo", "watch.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "other", pid: process.pid, host: hostname(), at: Date.now() }));
    await expect(watch()).rejects.toThrow(new RegExp(`already watched by pid ${process.pid}`));
    await rm(lock, { recursive: true });
    expect(await watch()).toBe(0);
    expect(await watch()).toBe(0); // --once released its lock
  });

  it("stops cleanly once the room has been archived", async () => {
    const { home, cli, watch } = await setup();
    await cmd.down(deps(home, "w1:p1", cli), "demo", false);
    await expect(watch()).rejects.toThrow(/does not exist/);
    await expect(appendEvent({ SPL_HOME: home }, "demo", () => ({ kind: "brief" as const, case: "c1", from: "lead", to: "p1", text: "x" })))
      .rejects.toThrow(/does not exist/);
    expect(await listRooms({ SPL_HOME: home })).toEqual([]);
    await expect(readdir(join(home, "rooms", "demo"))).rejects.toThrow();
  });
});

describe("spl watch: room identity", () => {
  it("stops a watcher whose room was archived and recreated under the same name", async () => {
    const { home, cli, room } = await setup();
    await cmd.down(deps(home, "w1:p1", cli), "demo", false);
    await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex"], supervisor: null });
    const d = { env: { SPL_HOME: home }, herdr: new Herdr(cli.exec, "herdr"), out: () => undefined };
    await expect(watchTick(d, room, DEFAULT_WATCH)).rejects.toThrow(/replaced/);
    expect((await readEvents({ SPL_HOME: home }, "demo")).filter((e) => e.kind === "alert")).toEqual([]);
  });
});
