import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Herdr, type ExecResult } from "../src/herdr.js";
import type { Deps } from "../src/commands.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spl-test-"));
  dirs.push(dir);
  return dir;
}

/** In-memory stand-in for the herdr CLI: allocates IDs and records every call. */
export class FakeHerdrCli {
  calls: string[][] = [];
  prompts: { target: string; text: string }[] = [];
  failPromptFor = new Set<string>();
  failStartFor = new Set<string>();
  /** Live agents by pane ID, as `agent list` reports them. */
  agents = new Map<string, { status: string; seq: number; kind?: string }>();
  failNotifications = false;
  failWorkspaceClose = false;
  failPaneRun = false;
  /** Test hook run inside the fake Jev fetch (not a herdr call). */
  onFetch: (() => Promise<void>) | undefined;
  notifications: { title: string; body: string }[] = [];
  private pane = 1;

  exec = async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    this.calls.push([...args]);
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" });
    const fail = (code: string) => ({ code: 1, stdout: "", stderr: JSON.stringify({ id: "cli", error: { code, message: `${code} (fake)` } }) });
    const [group, action] = args;
    if (group === "workspace" && action === "create") return ok({ type: "workspace_created", workspace: { workspace_id: "w9" }, root_pane: { pane_id: `w9:p${this.pane++}` } });
    if (group === "pane" && action === "split") return ok({ type: "pane_created", pane: { pane_id: `w9:p${this.pane++}` } });
    if (group === "agent" && action === "start") return this.failStartFor.has(args[2]!) ? fail("agent_not_ready") : ok({ type: "agent_started" });
    if (group === "agent" && action === "prompt") {
      if (this.failPromptFor.has(args[2]!)) return fail("agent_blocked");
      this.prompts.push({ target: args[2]!, text: args[3]! });
      return ok({ type: "agent_prompted" });
    }
    if (group === "agent" && action === "list") {
      return ok({ type: "agent_list", agents: [...this.agents].map(([pane_id, a]) => ({ pane_id, agent_status: a.status, state_change_seq: a.seq, agent: a.kind ?? null })) });
    }
    if (group === "notification" && action === "show") {
      if (this.failNotifications) return fail("notification_failed");
      const body = args[args.indexOf("--body") + 1] ?? "";
      this.notifications.push({ title: args[2]!, body });
      return ok({ type: "ok" });
    }
    if (group === "workspace" && action === "close") return this.failWorkspaceClose ? fail("workspace_not_found") : ok({ type: "ok" });
    if (group === "pane" && action === "run") return this.failPaneRun ? fail("pane_not_found") : ok({ type: "ok" });
    return fail("unsupported_in_fake");
  };
}

export function deps(home: string, pane: string | undefined, cli: FakeHerdrCli, out: string[] = []): Deps {
  return {
    env: { SPL_HOME: home, ...(pane ? { HERDR_PANE_ID: pane } : {}) },
    herdr: new Herdr(cli.exec, "herdr"),
    out: (line) => { out.push(line); },
  };
}
