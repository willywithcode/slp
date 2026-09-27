import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Deps } from "../src/core/deps.js";
import { Herdr } from "../src/herdr.js";
import { newer, update, type Run } from "../src/update.js";
import { commitFile, sh, tempDir, tempRepo, World } from "./helpers.js";

function github(tag: string, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function deps(tag: string, out: string[]): Promise<Deps> {
  return { env: { SLP_HOME: await tempDir() }, herdr: new Herdr(async () => ({ code: 1, stdout: "", stderr: "" })), out: (l) => out.push(l), fetch: github(tag) };
}

describe("slp update", () => {
  it("compares versions", () => {
    expect(newer("v0.3.10", "0.3.9")).toBe(true);
    expect(newer("v0.3.3", "0.3.3")).toBe(false);
    expect(newer("v0.4.0", "0.3.99")).toBe(true);
    expect(newer("v0.3.2", "0.3.3")).toBe(false);
  });

  it("only reports with --dry-run", async () => {
    const out: string[] = [];
    let ran = false;
    const run: Run = async () => { ran = true; return { code: 0, output: "" }; };
    await update(await deps("v0.4.0", out), { check: true, run, installed: { version: "0.3.3", root: await tempDir() } });
    expect(out.join("\n")).toMatch(/installed v0\.3\.3; latest v0\.4\.0[\s\S]*A newer slp is out/);
    expect(ran).toBe(false);
  });

  it("installs the release tarball globally when slp was installed from npm", async () => {
    const out: string[] = [];
    const runs: string[][] = [];
    const run: Run = async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, output: "" }; };
    await update(await deps("v0.4.0", out), { check: false, run, installed: { version: "0.3.3", root: await tempDir() } });
    expect(runs).toEqual([["npm", "install", "-g", "https://github.com/willywithcode/slp/archive/refs/tags/v0.4.0.tar.gz"]]);
    const same: string[] = [];
    await update(await deps("v0.3.3", same), { check: false, run, installed: { version: "0.3.3", root: await tempDir() } });
    expect(same.at(-1)).toBe("Up to date.");
    expect(runs).toHaveLength(1);
  });

  it("fast-forwards a linked clone, and refuses one with local work", async () => {
    const origin = await tempRepo();
    const clone = join(await tempDir(), "slp");
    sh(origin, "clone", "-q", origin, clone);
    sh(clone, "config", "user.email", "t@e.st");
    sh(clone, "config", "user.name", "t");
    await commitFile(origin, "package.json", JSON.stringify({ version: "0.4.0" }));
    const out: string[] = [];
    await update(await deps("v0.4.0", out), { check: false, installed: { version: "0.3.3", root: clone } });
    expect(sh(clone, "rev-parse", "HEAD")).toBe(sh(origin, "rev-parse", "HEAD"));
    expect(out.join("\n")).toContain("updated the clone");
    await writeFile(join(clone, "wip.txt"), "x");
    await expect(update(await deps("v0.5.0", []), { check: false, installed: { version: "0.4.0", root: clone } })).rejects.toThrow(/uncommitted changes/);
  });

  it("is the Human's command", async () => {
    const w = await World.create();
    await w.slp(["start"]);
    await expect(w.as("sup", ["update"])).rejects.toThrow(/Human's command/);
    void mkdir;
  });
});
