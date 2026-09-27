import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeText } from "../src/cli.js";
import { chooseSeat, defaultConfig, loadConfig, parseConfig } from "../src/core/config.js";
import { configPath } from "../src/core/paths.js";
import { detectGate, runGate } from "../src/gate.js";
import { isCatchAll, matches, overlaps } from "../src/globs.js";
import { agentArgs } from "../src/roles.js";
import { envCommands, readyProbe, shellFamily } from "../src/shells.js";
import { tempDir } from "./helpers.js";

describe("globs", () => {
  it("matches paths", () => {
    expect(matches(["src/**"], "src/a/b.ts")).toBe(true);
    expect(matches(["src/*.ts"], "src/a/b.ts")).toBe(false);
    expect(matches(["src/a"], "src/a/b.ts")).toBe(true);
    expect(matches(["**/*.md"], "docs/x.md")).toBe(true);
    expect(matches(["src\\a\\**"], "src/a/x")).toBe(true);
  });

  it("overlaps conservatively", () => {
    expect(overlaps(["src/**"], ["src/a/**"])).toBe(true);
    expect(overlaps(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(overlaps(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(overlaps(["src/a.ts"], ["src/*.ts"])).toBe(true);
    expect(overlaps(["docs/**"], ["src/**"])).toBe(false);
  });

  it("names catch-alls", () => {
    for (const g of ["**", "*", "**/*", "**/*.ts", "*.ts", "", "./"]) expect(isCatchAll(g)).toBe(true);
    for (const g of ["src/**", "README.md"]) expect(isCatchAll(g)).toBe(false);
  });
});

describe("shells", () => {
  it("tells shells apart", () => {
    expect(shellFamily(["pwsh.exe"])).toBe("powershell");
    expect(shellFamily(["powershell"])).toBe("powershell");
    expect(shellFamily(["zsh"])).toBe("sh");
    expect(shellFamily(["cmd.exe"])).toBe("cmd");
    expect(shellFamily(["node"])).toBeNull();
  });

  it("sets and unsets variables in each shell's syntax, quoting values", () => {
    expect(envCommands("powershell", { A: "it's", B: null })).toEqual(["$env:A = 'it''s'", "Remove-Item Env:B -ErrorAction SilentlyContinue"]);
    expect(envCommands("sh", { A: "it's", B: null })).toEqual(["export A='it'\\''s'", "unset B"]);
    expect(() => envCommands("sh", { "A B": "x" })).toThrow(/Invalid/);
    expect(() => envCommands("cmd", { A: "a&b" })).toThrow(/safely/);
  });

  it("never types the text it waits for", () => {
    for (const family of ["powershell", "sh", "cmd"] as const) {
      const p = readyProbe(family, "abc123");
      expect(p.match).toBe("slp-ready-abc123");
      expect(p.command).not.toContain(p.match);
    }
  });
});

describe("config", () => {
  it("writes the defaults on first use and reads them back, BOM or not", async () => {
    const home = await tempDir();
    const env = { SLP_HOME: home };
    const first = await loadConfig(env, "linux");
    expect(first.roles.supervisor.effort).toBe("xhigh");
    const raw = await readFile(configPath(env), "utf8");
    await writeFile(configPath(env), String.fromCharCode(0xfeff) + raw);
    expect((await loadConfig(env, "linux")).roles.peer.defaultPreset).toBe("sol");
    await writeFile(configPath(env), "{");
    await expect(loadConfig(env)).rejects.toThrow(/not valid JSON/);
  });

  it("matches the owner's accounts on Windows (ADR 0011)", () => {
    const c = defaultConfig("win32");
    expect(c.roles.supervisor).toMatchObject({ use: ["claude"], model: "claude-opus-5-5[1m]", effort: "xhigh" });
    expect(c.roles.lead).toMatchObject({ use: ["claude-acc1"], effort: "high" });
    expect(c.roles.reviewer.use).toEqual(["claude-acc2"]);
    expect(c.roles.peer.use).toEqual(["codex-acc1", "codex-acc2", "codex-acc3"]);
    // slp only names the secret file; the pane's own shell decrypts it.
    expect(c.launchers["claude-acc1"]!.prep.powershell).toContain("claude-acc1.txt");
    expect(JSON.stringify(c)).not.toMatch(/sk-|token=/i);
  });

  it("rotates launchers and applies presets", () => {
    const c = defaultConfig("win32");
    expect(chooseSeat(c, "peer", 0).launcherName).toBe("codex-acc1");
    expect(chooseSeat(c, "peer", 4).launcherName).toBe("codex-acc2");
    expect(chooseSeat(c, "peer", 1, "luna")).toMatchObject({ launcherName: "codex-acc2", model: "gpt-6-luna" });
    expect(chooseSeat(c, "peer", 0, "flash")).toMatchObject({ launcherName: "agy", model: "gemini-3.8-flash-high" });
    expect(() => chooseSeat(c, "peer", 0, "nope")).toThrow(/Unknown peer preset/);
  });

  it("rejects unknown launchers", () => {
    const c = defaultConfig("linux");
    c.roles.lead.use = ["ghost"];
    expect(() => parseConfig(c)).toThrow(/unknown launcher "ghost"/);
  });
});

describe("agent arguments", () => {
  const base = { model: "m", effort: "high", sessionId: null, markerDir: null, slpHome: "/h", projectDir: "/h/p" };

  it("gives Claude seats their role's settings file", () => {
    const sup = agentArgs("claude", { ...base, role: "supervisor", sessionId: "u", settingsPath: "/h/settings/claude-supervisor.json" });
    expect(sup).toEqual(expect.arrayContaining(["--session-id", "u", "--settings", "/h/settings/claude-supervisor.json"]));
    expect(sup).not.toContain("--add-dir");
    expect(sup).not.toContain("--allowedTools");
  });

  it("runs Codex in its own process, never asking inside its sandbox (ADR 0016)", () => {
    const args = agentArgs("codex", { ...base, role: "peer", markerDir: "/h/p/seats/L1-T1", writableDirs: ["/repo/.git"] });
    expect(args.slice(0, 3)).toEqual(["--no-daemon", "--sandbox", "workspace-write"]);
    expect(args).toEqual(expect.arrayContaining(["--ask-for-approval", "never", "sandbox_workspace_write.network_access=true"]));
    expect(args).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=high", "--add-dir", "/h", "/h/p/seats/L1-T1", "/repo/.git"]));
  });
});

describe("gate", () => {
  it("detects the project's test command", async () => {
    const dir = await tempDir();
    expect(await detectGate(dir)).toBeNull();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    expect(await detectGate(dir)).toBeNull();
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(await detectGate(dir)).toBe("npm test");
    const go = await tempDir();
    await writeFile(join(go, "go.mod"), "module x\n");
    expect(await detectGate(go)).toBe("go test ./...");
  });

  it("runs it and keeps the tail", { timeout: 20_000 }, async () => {
    const dir = await tempDir();
    const green = await runGate("node -e \"console.log('fine')\"", dir, 30_000);
    expect(green).toMatchObject({ ok: true });
    expect(green.tail).toContain("fine");
    const red = await runGate("node -e \"console.error('broke'); process.exit(2)\"", dir, 30_000);
    expect(red.ok).toBe(false);
    expect(red.tail).toContain("broke");
    const slow = await runGate("node -e \"setTimeout(() => {}, 20000)\"", dir, 1500);
    expect(slow.ok).toBe(false);
    expect(slow.tail).toContain("timed out");
  });
});

describe("text input", () => {
  it("decodes UTF-8 with or without BOM, and UTF-16 from PowerShell", () => {
    expect(decodeText(Buffer.from("héllo"))).toBe("héllo");
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]))).toBe("x");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]))).toBe("hi");
  });
});

// Keep mkdir referenced for platforms where tempDir needs a nested directory.
void mkdir;
