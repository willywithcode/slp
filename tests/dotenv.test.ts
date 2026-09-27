import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotenv, withDotenv } from "../src/core/dotenv.js";
import { claudeSettings } from "../src/permissions.js";
import { tempDir } from "./helpers.js";

describe("~/.slp/.env", () => {
  it("parses keys, comments, export and quotes", () => {
    expect(parseDotenv(String.fromCharCode(0xfeff) + "# Jev\nJEV_API_KEY=abc # note\nexport OPENROUTER_API_KEY='sk or'\nJEV_MODEL=\"jev-1.13.0\"\nbad line\n\n")).toEqual({
      JEV_API_KEY: "abc", OPENROUTER_API_KEY: "sk or", JEV_MODEL: "jev-1.13.0",
    });
  });

  it("sits under the environment, which wins", async () => {
    const home = await tempDir();
    await writeFile(join(home, ".env"), "JEV_API_KEY=from-file\nJEV_MODEL=jev-1.13.0\n");
    if (process.platform !== "win32") await chmod(join(home, ".env"), 0o600);
    const env = await withDotenv({ SLP_HOME: home, JEV_API_KEY: "from-env" });
    expect(env).toMatchObject({ JEV_API_KEY: "from-env", JEV_MODEL: "jev-1.13.0" });
    expect(await withDotenv({ SLP_HOME: await tempDir() })).toMatchObject({});
  });

  it.skipIf(process.platform === "win32")("refuses a file other users can read", async () => {
    const home = await tempDir();
    await writeFile(join(home, ".env"), "JEV_API_KEY=x\n");
    await chmod(join(home, ".env"), 0o644);
    await expect(withDotenv({ SLP_HOME: home })).rejects.toThrow(/chmod 600/);
  });

  it("is refused to Claude seats", () => {
    expect(claudeSettings("peer", false, "/h").permissions.deny).toContain("Read(~/.slp/.env)");
  });
});
