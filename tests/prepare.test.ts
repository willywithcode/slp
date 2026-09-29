import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitFile, World } from "./helpers.js";

// ADR 0019: new working copies are made ready before their seat starts.

const ISOLATED = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**", "--home", "isolate"];

async function started(setup: string | null = null): Promise<World> {
  const w = await World.create();
  const path = join(w.home, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...config, lanes: { home: "auto", setup } }));
  await w.slp(["start"]);
  w.cli.idleAll();
  return w;
}

describe("preparing a new copy", () => {
  it("copies the git-ignored files .worktreeinclude names, and nothing else ignored", async () => {
    const w = await started();
    await commitFile(w.repo, ".gitignore", "secrets.env\nLibrary/\n");
    await commitFile(w.repo, ".worktreeinclude", "secrets.env\n");
    await writeFile(join(w.repo, "secrets.env"), "KEY=local\n");
    await mkdir(join(w.repo, "Library"), { recursive: true });
    await writeFile(join(w.repo, "Library", "cache.bin"), "big\n");
    await w.as("sup", ISOLATED);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(await readFile(join(lane.workdir, "secrets.env"), "utf8")).toBe("KEY=local\n");
    expect(existsSync(join(lane.workdir, "Library", "cache.bin"))).toBe(false);
    expect((await w.inbox("L1")).join("\n")).toContain(".worktreeinclude: 1 git-ignored file(s) copied in.");
  });

  it("runs lanes.setup in a new lane copy and a parallel task's copy, and tells the Lead", async () => {
    const w = await started(`node -e "require('fs').writeFileSync('setup-ran.txt', process.cwd())"`);
    await w.as("sup", ISOLATED);
    const lane = (await w.state()).lanes.get("L1")!;
    expect(existsSync(join(lane.workdir, "setup-ran.txt"))).toBe(true);
    expect((await w.inbox("L1")).join("\n")).toMatch(/Setup `node -e .*` ran in the new copy/);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "b", "--goal", "g", "--accept", "x", "--own", "src/b/**", "--parallel"]);
    const task = (await w.state()).tasks.get("L1-T1")!;
    expect(existsSync(join(task.workdir, "setup-ran.txt"))).toBe(true);
    expect(w.out.some((l) => l.startsWith("Setup `node -e"))).toBe(true);
  });

  it("does not run setup in the Human's checkout", async () => {
    const w = await started(`node -e "require('fs').writeFileSync('setup-ran.txt', 'x')"`);
    await w.as("sup", ["open-lane", "--title", "G", "--outcome", "o", "--accept", "a", "--write", "src/**"]);
    expect(existsSync(join(w.repo, "setup-ran.txt"))).toBe(false);
  });

  it("reports a failed setup to the Lead and still starts the lane", async () => {
    const w = await started(`node -e "console.error('no network'); process.exit(3)"`);
    await w.as("sup", ISOLATED);
    const s = await w.state();
    expect(s.lanes.get("L1")!.open).toBe(true);
    expect((await w.inbox("L1")).join("\n")).toMatch(/Setup `node -e .*` FAILED in the new copy[\s\S]*no network/);
  });
});

describe("submodules", () => {
  it("warns when a write set reaches into a submodule, and suggests a setup for new copies", async () => {
    const w = await started();
    await commitFile(w.repo, ".gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n');
    await w.as("sup", ["open-lane", "--title", "V", "--outcome", "o", "--accept", "a", "--write", "vendor/lib/**", "--home", "isolate"]);
    expect(w.out.some((l) => l.includes("reaches into submodule(s) vendor/lib"))).toBe(true);
    const directive = (await w.inbox("L1")).join("\n");
    expect(directive).toContain("do not land with this repository's squash");
    expect(directive).toContain("git submodule update --init --recursive");
    await w.as("sup", ["open-lane", "--title", "S", "--outcome", "o", "--accept", "a", "--write", "src/**", "--home", "isolate"]);
    expect(w.out.filter((l) => l.includes("reaches into submodule")).length).toBe(1);
  });
});
