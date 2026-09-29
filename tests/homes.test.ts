import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../src/core/paths.js";
import { placeLane } from "../src/lanes.js";
import { commitFile, sh, World } from "./helpers.js";

// ADR 0018: where lanes work, the lane queue, and kept working copies.

const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];
const DOCS = ["open-lane", "--title", "Docs", "--outcome", "docs", "--accept", "a", "--write", "docs/**"];

async function started(): Promise<World> {
  const w = await World.create();
  await w.slp(["start"]);
  w.cli.idleAll();
  return w;
}

const watchOnce = (w: World) => w.slp(["watch", "--once", "--project", w.project]);
const slots = (w: World) => join(projectDir({ SLP_HOME: w.home }, w.project), "slots");

describe("placing a lane", () => {
  const clean = { branch: "main", changes: [], busyWith: null };
  it("takes the checkout only when it is free, clean and on base", () => {
    expect(placeLane("auto", clean, "main", false)).toEqual({ home: "newBranch" });
    expect(placeLane("auto", { ...clean, busyWith: "L1" }, "main", false)).toMatchObject({ refused: expect.stringContaining("--after L1") });
    expect(placeLane("auto", { ...clean, branch: "feature" }, "main", false)).toMatchObject({ refused: expect.stringContaining("--home onBranch") });
    expect(placeLane("auto", { ...clean, changes: [" M a.cs"] }, "main", false)).toMatchObject({ refused: expect.stringContaining(" M a.cs") });
    expect(placeLane("newBranch", { ...clean, changes: [" M a.cs"] }, "main", true)).toEqual({ home: "newBranch" });
    expect(placeLane("onBranch", { ...clean, branch: "feature", changes: [" M a.cs"] }, "main", false)).toEqual({ home: "onBranch" });
    expect(placeLane("onBranch", { ...clean, branch: null }, "main", false)).toMatchObject({ refused: expect.stringContaining("detached") });
    expect(placeLane("isolate", { ...clean, busyWith: "L1", changes: ["x"] }, "main", false)).toEqual({ home: "isolate" });
  });
});

describe("where lanes work", () => {
  it("never copies the repository silently: a dirty checkout gets the reason and the choices", async () => {
    const w = await started();
    await mkdir(join(w.repo, "Assets"), { recursive: true });
    await commitFile(w.repo, "Assets/ThirdPartyService.cs", "v1\n");
    await writeFile(join(w.repo, "Assets/ThirdPartyService.cs"), "v2\n");
    await expect(w.as("sup", LANE)).rejects.toThrow(/M Assets\/ThirdPartyService\.cs[\s\S]*--home onBranch[\s\S]*--carry[\s\S]*--home isolate/);
    expect((await w.state()).lanes.size).toBe(0);
    expect(existsSync(slots(w))).toBe(false);
    expect(w.cli.notifications.some((n) => n.title.includes("waits on your choice") && n.body.includes("uncommitted"))).toBe(true);
  });

  it("untracked files alone do not keep a lane out of the checkout, nor block its landing", async () => {
    const w = await started();
    await writeFile(join(w.repo, "editor.utmp"), "tool output\n");
    await w.as("sup", LANE);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(lane).toMatchObject({ inCheckout: true, home: "newBranch" });
    await commitFile(w.repo, "src/a.js", "a\n");
    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    expect((await w.state()).lanes.get("L1")!.landed).toBe(true);
    expect(existsSync(join(w.repo, "editor.utmp"))).toBe(true);
  });

  it("onBranch works on the Human's branch as it is, and landing moves no branch", async () => {
    const w = await started();
    sh(w.repo, "switch", "-q", "-c", "feature");
    await writeFile(join(w.repo, "README.md"), "the Human's own edit\n");
    const main = sh(w.repo, "rev-parse", "main");
    await w.as("sup", [...LANE, "--home", "onBranch"]);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(lane).toMatchObject({ home: "onBranch", branch: "feature", base: "feature", inCheckout: true });
    expect((await w.inbox("L1")).join("\n")).toMatch(/never `git add -A`/);
    await mkdir(join(w.repo, "src"), { recursive: true });
    await writeFile(join(w.repo, "src/a.js"), "a\n");
    sh(w.repo, "add", "src/a.js");
    sh(w.repo, "commit", "-q", "-m", "a");
    const tip = sh(w.repo, "rev-parse", "HEAD");
    w.cli.idleAll();
    expect(await w.as("L1", ["diff", "L1"])).toBe(0);
    expect(w.out.at(-1)).toContain("src/a.js");
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    const done = (await w.state()).lanes.get("L1")!;
    expect(done).toMatchObject({ landed: true, commit: tip });
    expect(sh(w.repo, "rev-parse", "feature")).toBe(tip);
    expect(sh(w.repo, "rev-parse", "main")).toBe(main);
    expect(sh(w.repo, "branch", "--show-current")).toBe("feature");
    expect(await readFile(join(w.repo, "README.md"), "utf8")).toBe("the Human's own edit\n");
  });

  it("onBranch refuses to land while the write set holds uncommitted work", async () => {
    const w = await started();
    await w.as("sup", [...LANE, "--home", "onBranch"]);
    await mkdir(join(w.repo, "src"), { recursive: true });
    await writeFile(join(w.repo, "src/draft.js"), "x\n");
    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await watchOnce(w);
    const s = await w.state();
    expect(s.lanes.get("L1")!.open).toBe(true);
    expect(s.letters.at(-1)?.text ?? "").toMatch(/uncommitted changes .*src\/draft\.js/);
  });

  it("newBranch --carry takes the Human's changes into the lane and tells the Lead", async () => {
    const w = await started();
    await writeFile(join(w.repo, "README.md"), "carried\n");
    await w.as("sup", [...LANE, "--home", "newBranch", "--carry"]);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(lane.carried).toEqual([" M README.md"]);
    expect(sh(w.repo, "branch", "--show-current")).toBe(lane.branch);
    expect(await readFile(join(w.repo, "README.md"), "utf8")).toBe("carried\n");
    expect((await w.inbox("L1")).join("\n")).toMatch(/carried into this lane[\s\S]*README\.md/);
  });

  it("the config's lanes.home is the default", async () => {
    const w = await started();
    const path = join(w.home, "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, lanes: { home: "isolate", setup: null } }));
    await w.as("sup", LANE);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(lane).toMatchObject({ home: "isolate", inCheckout: false });
    expect(existsSync(lane.workdir)).toBe(true);
  });
});

describe("the lane queue", () => {
  it("--after waits for the lane to close, then opens in the checkout", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await w.as("sup", [...DOCS, "--after", "L1"]);
    let s = await w.state();
    expect(s.lanes.has("L2")).toBe(false);
    expect(s.queued.get("L2")).toMatchObject({ after: "L1" });
    await w.slp(["status"]);
    expect(w.out.at(-1)).toMatch(/Queued lanes:\n {2}L2 Docs · opens in your checkout after L1/);

    // Waiting while L1 is open.
    await watchOnce(w);
    expect((await w.state()).lanes.has("L2")).toBe(false);

    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--drop", "--reason", "not now"]);
    await watchOnce(w);
    s = await w.state();
    expect(s.queued.size).toBe(0);
    expect(s.lanes.get("L2")).toMatchObject({ open: true, inCheckout: true, home: "newBranch" });
    expect(s.letters.some((l) => l.to === "sup" && l.text.includes("L2 (Docs) opened"))).toBe(true);
    // A new lane's id comes after the queued one's.
    await w.as("sup", ["open-lane", "--title", "C", "--outcome", "o", "--accept", "a", "--write", "lib/**", "--home", "isolate"]);
    expect((await w.state()).lanes.has("L3")).toBe(true);
  });

  it("a queued lane that cannot open when its turn comes is taken off the queue, with the reason", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await w.as("sup", [...DOCS, "--after", "L1"]);
    w.cli.idleAll();
    await w.as("sup", ["close-lane", "L1", "--drop", "--reason", "not now"]);
    await writeFile(join(w.repo, "README.md"), "the Human is editing\n");
    await watchOnce(w);
    const s = await w.state();
    expect(s.lanes.has("L2")).toBe(false);
    expect(s.queued.size).toBe(0);
    expect(s.letters.some((l) => l.to === "sup" && /L2 \(Docs\) was waiting for L1[\s\S]*README\.md/.test(l.text))).toBe(true);
    expect(w.cli.notifications.some((n) => n.title.includes("L2 could not open"))).toBe(true);
  });

  it("a queued lane can be dropped before it opens", async () => {
    const w = await started();
    await w.as("sup", LANE);
    await w.as("sup", [...DOCS, "--after", "L1"]);
    await expect(w.as("sup", ["close-lane", "L2", "--land"])).rejects.toThrow(/queued/);
    await w.as("sup", ["close-lane", "L2", "--drop", "--reason", "changed my mind"]);
    expect((await w.state()).queued.size).toBe(0);
    await expect(w.as("sup", [...DOCS, "--after", "L9"])).rejects.toThrow(/No open or queued lane L9/);
  });
});

describe("kept working copies", () => {
  async function keptCopy(w: World): Promise<string> {
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**", "--parallel"]);
    const t = (await w.state()).tasks.get("L1-T1")!;
    await writeFile(join(t.workdir, "README.md"), "unsaved\n");
    w.cli.idleAll();
    await w.as("L1", ["cut", "L1-T1", "wrong idea"]);
    return t.workdir;
  }

  it("shows in status, and slp clean removes it only with --force while it holds changes", async () => {
    const w = await started();
    const path = await keptCopy(w);
    await w.slp(["status"]);
    expect(w.out.at(-1)).toContain(`Kept working copies (remove with \`slp clean\``);
    expect(w.out.at(-1)).toContain(`${path} (L1-T1,`);
    await mkdir(join(slots(w), "orphan"), { recursive: true });
    await w.slp(["clean"]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(slots(w), "orphan"))).toBe(false);
    expect(w.out.at(-1)).toBe("1 removed, 1 kept");
    await w.slp(["clean", "--force"]);
    expect(existsSync(path)).toBe(false);
    expect((await w.state()).keptSlots.size).toBe(0);
    await expect(w.as("sup", ["clean"])).rejects.toThrow(/the Human's command/);
  });

  it("the watcher removes a kept copy once its changes are gone", async () => {
    const w = await started();
    const path = await keptCopy(w);
    await watchOnce(w);
    expect(existsSync(path)).toBe(true);
    sh(path, "checkout", "--", "README.md");
    await watchOnce(w);
    expect(existsSync(path)).toBe(false);
    expect((await w.state()).keptSlots.size).toBe(0);
  });
});
