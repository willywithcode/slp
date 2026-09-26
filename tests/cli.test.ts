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
    await writeFile(brief, "Line one\nLine two");
    expect(await main(["send", "p1", "--file", brief], lead, d)).toBe(0);
    expect(cli.prompts.at(-1)!.text).toContain("Line one\nLine two");
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
