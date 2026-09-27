import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { Herdr, HerdrError } from "../src/herdr.js";
import { FakeHerdrCli, tempHome } from "./helpers.js";

describe("cli", () => {
  it("drives a room end to end through argv, including --file", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    const out: string[] = [];
    const d = { herdr: new Herdr(cli.exec, "herdr"), out: (s: string) => { out.push(s); } };
    expect(await main(["up", "demo", "--peers", "codex", "--supervisor", "none", "--cwd", home], { SPL_HOME: home }, d)).toBe(0);
    const lead = { SPL_HOME: home, HERDR_PANE_ID: "w9:p1" };
    const peer = { SPL_HOME: home, HERDR_PANE_ID: "w9:p2" };

    const brief = join(home, "brief.md");
    await writeFile(brief, "\uFEFFLine one\nLine two"); // PowerShell writes a BOM
    expect(await main(["send", "p1", "--file", brief], lead, d)).toBe(0);
    expect(cli.prompts.at(-1)!.text).toContain("from lead]\n\nLine one\nLine two");
    expect(await main(["handback", "c1", "Finished; evidence attached."], peer, d)).toBe(0);
    expect(await main(["reply", "c1", "p1", "Accepted.", "--close"], lead, d)).toBe(0);
    expect(cli.prompts.at(-1)!.text).toContain("case closed");

    out.length = 0;
    expect(await main(["whoami"], peer, d)).toBe(0);
    expect(out).toEqual(["p1 (peer) in room demo"]);
    out.length = 0;
    expect(await main(["guide"], peer, d)).toBe(0);
    expect(out[0]).toMatch(/^# SPL guide: Peer/);
  });

  it("rejects bad usage", async () => {
    const d = { herdr: new Herdr(new FakeHerdrCli().exec), out: () => undefined };
    await expect(main(["send"], {}, d)).rejects.toThrow(/Wrong number of arguments/);
    await expect(main(["frobnicate"], {}, d)).rejects.toThrow(/Unknown command/);
    await expect(main(["guide", "boss"], {}, d)).rejects.toThrow(/Role must be/);
  });
});

describe("herdr wrapper", () => {
  it("surfaces herdr JSON errors with their code", async () => {
    const h = new Herdr(async () => ({ code: 1, stdout: "", stderr: '{"id":"x","error":{"code":"agent_blocked","message":"blocked"}}' }));
    await expect(h.prompt("a", "b")).rejects.toMatchObject({ code: "agent_blocked" } satisfies Partial<HerdrError>);
  });

  it("reports non-JSON failures and malformed success responses", async () => {
    await expect(new Herdr(async () => ({ code: 2, stdout: "", stderr: "usage: ..." })).prompt("a", "b")).rejects.toThrow("usage: ...");
    await expect(new Herdr(async () => ({ code: 0, stdout: '{"result":{}}', stderr: "" })).paneSplit("p", { direction: "right", cwd: ".", env: {} }))
      .rejects.toThrow(/missing pane.pane_id/);
  });
});

describe("platform hints", () => {
  it("tells agents on Windows to call spl.cmd, where PowerShell blocks spl.ps1", async () => {
    const { onboarding, guide } = await import("../src/protocol.js");
    expect(onboarding("demo", "p1", "peer", "roster", "win32", "codex")).toContain("spl.cmd");
    expect(onboarding("demo", "p1", "peer", "roster", "linux", "codex")).not.toContain("spl.cmd");
    // Claude Code runs Git Bash on Windows, where `spl` works; the hint only
    // made it write `spl ... || spl.cmd ...`, which needed a fresh approval.
    expect(onboarding("demo", "lead", "lead", "roster", "win32", "claude")).not.toContain("spl.cmd");
    expect(guide("peer", "win32")).toContain("spl.cmd");
    expect(guide("peer", "darwin")).not.toContain("spl.cmd");
  });

  it("explains a pane mismatch caused by agents that run commands elsewhere", async () => {
    const home = await tempHome();
    await expect(main(["whoami"], { SPL_HOME: home, HERDR_PANE_ID: "wE:p1" }, { herdr: new Herdr(new FakeHerdrCli().exec), out: () => undefined }))
      .rejects.toThrow(/shared background server.*--no-daemon/);
  });
});

describe("guide", () => {
  it("steers long messages to stdin and never into the repository", async () => {
    const { guide } = await import("../src/protocol.js");
    for (const role of ["lead", "peer"] as const) {
      const text = guide(role, "linux");
      expect(text).toContain("- <<'EOF'");
      expect(text).toMatch(/never inside the repository/);
      expect(text).not.toContain("--file brief.md");
    }
  });
});

describe("message files", () => {
  it("reads UTF-16 files written by Windows PowerShell 5.1", async () => {
    const home = await tempHome();
    const cli = new FakeHerdrCli();
    const d = { herdr: new Herdr(cli.exec, "herdr"), out: () => undefined };
    await main(["up", "demo", "--peers", "codex", "--supervisor", "none", "--cwd", home], { SPL_HOME: home }, d);
    const file = join(home, "brief-utf16.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Héllo\r\nworld", "utf16le")]));
    await main(["send", "p1", "--file", file], { SPL_HOME: home, HERDR_PANE_ID: "w9:p1" }, d);
    expect(cli.prompts.at(-1)!.text).toContain("from lead]\n\nHéllo\r\nworld\n\n[SPL]");
  });
});
