import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Herdr, type ExecResult } from "../src/herdr.js";
import { startRetry, submitCheck, type Deps } from "../src/commands.js";

// Busy-pane retries must not slow the suite down.
startRetry.delayMs = 1;
submitCheck.waitMs = 30;
submitCheck.pollMs = 5;

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
  /** Visible screen text per agent name, as `agent read` reports it. */
  screens = new Map<string, string>();
  /** Panes whose agent leaves a prompt as unsent pasted text until Enter is pressed. */
  swallowEnter = new Set<string>();
  keys: { target: string; keys: string[] }[] = [];
  /** Screen text above the input line, per pane. */
  scrollback = new Map<string, string>();
  /** Remaining `agent start` attempts per pane that fail with agent_pane_busy. */
  busyStarts = new Map<string, number>();
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
    if (group === "agent" && action === "start") {
      const pane = args[args.indexOf("--pane") + 1]!;
      const busy = this.busyStarts.get(pane) ?? 0;
      if (busy > 0) { this.busyStarts.set(pane, busy - 1); return fail("agent_pane_busy"); }
      return this.failStartFor.has(args[2]!) ? fail("agent_not_ready") : ok({ type: "agent_started" });
    }
    if (group === "agent" && action === "prompt") {
      if (this.failPromptFor.has(args[2]!)) return fail("agent_blocked");
      this.prompts.push({ target: args[2]!, text: args[3]! });
      const agent = this.agents.get(args[2]!);
      if (agent && this.swallowEnter.has(args[2]!)) {
        agent.status = "idle";
        this.screens.set(args[2]!, `${this.scrollback.get(args[2]!) ?? ""}> [Pasted text #1 +40 lines]`);
      }
      else if (agent) agent.status = "working";
      return ok({ type: "agent_prompted" });
    }
    if (group === "agent" && action === "get") {
      const agent = this.agents.get(args[2]!);
      return agent ? ok({ type: "agent_info", agent: { pane_id: args[2], agent_status: agent.status, agent: agent.kind ?? null } }) : fail("agent_not_found");
    }
    if (group === "agent" && action === "send-keys") {
      this.keys.push({ target: args[2]!, keys: args.slice(3) });
      const agent = this.agents.get(args[2]!);
      if (agent && args.includes("enter") && this.screens.get(args[2]!)?.includes("Pasted text")) {
        this.screens.delete(args[2]!);
        agent.status = "working";
      }
      return ok({ type: "ok" });
    }
    // Like the real CLI, `agent read` prints the screen as plain text.
    if (group === "agent" && action === "read") return { code: 0, stdout: this.screens.get(args[2]!) ?? "> ready", stderr: "" };
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

/** A caller inside an agent sandbox: it can write files but cannot reach Herdr. */
export function sandboxed(home: string, pane: string, out: string[] = []): Deps {
  const denied = async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: 'Error: Os { code: 5, kind: PermissionDenied, message: "Access is denied." }' });
  return { env: { SPL_HOME: home, HERDR_PANE_ID: pane }, herdr: new Herdr(denied, "herdr"), out: (line) => { out.push(line); } };
}
