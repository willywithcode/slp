import { execFile } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const defaultExec: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
  });
});

/** Thin typed wrapper over the `herdr` CLI. Every call returns herdr's JSON `result`. */
export class Herdr {
  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly bin: string = process.env.HERDR_BIN_PATH || "herdr",
  ) {}

  private async call(args: readonly string[]): Promise<Record<string, any>> {
    return parse(await this.run(args))?.result ?? {};
  }

  /** Run a command and return its stdout; errors are herdr's JSON on stderr. */
  private async run(args: readonly string[]): Promise<string> {
    const { code, stdout, stderr } = await this.exec(this.bin, args);
    if (code !== 0) {
      const body = parse(stderr) ?? parse(stdout);
      const error = body?.error;
      if (error && typeof error.code === "string") throw new HerdrError(error.code, String(error.message ?? error.code));
      throw new HerdrError("cli_failed", (stderr || stdout).trim() || `herdr exited with ${code}`);
    }
    return stdout;
  }

  async workspaceCreate(opts: { cwd: string; label: string; env: Record<string, string> }): Promise<{ workspaceId: string; rootPaneId: string }> {
    const r = await this.call(["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, ...envArgs(opts.env), "--no-focus"]);
    return { workspaceId: required(r.workspace?.workspace_id, "workspace_id"), rootPaneId: required(r.root_pane?.pane_id, "root_pane.pane_id") };
  }

  async paneSplit(paneId: string, opts: { direction: "right" | "down"; cwd: string; env: Record<string, string> }): Promise<string> {
    const r = await this.call(["pane", "split", paneId, "--direction", opts.direction, "--cwd", opts.cwd, ...envArgs(opts.env), "--no-focus"]);
    return required(r.pane?.pane_id, "pane.pane_id");
  }

  async tabCreate(opts: { workspaceId: string; cwd: string; label: string; env: Record<string, string> }): Promise<{ tabId: string; rootPaneId: string }> {
    const r = await this.call(["tab", "create", "--workspace", opts.workspaceId, "--cwd", opts.cwd, "--label", opts.label, ...envArgs(opts.env), "--no-focus"]);
    return { tabId: required(r.tab?.tab_id, "tab.tab_id"), rootPaneId: required(r.root_pane?.pane_id, "root_pane.pane_id") };
  }

  async tabClose(tabId: string): Promise<void> {
    await this.call(["tab", "close", tabId]);
  }

  /**
   * The pane's shell process id and the processes Herdr sees in its
   * foreground. On Windows the foreground list can name a stray process that
   * is not the pane's shell (seen live: a Codex app-server), so callers
   * prefer `shellPid`.
   */
  async paneProcesses(paneId: string): Promise<{ shellPid: number | null; foreground: { name: string; pid: number | null }[] }> {
    const r = await this.call(["pane", "process-info", "--pane", paneId]);
    const info = r.process_info ?? {};
    const procs: unknown = info.foreground_processes;
    const foreground = Array.isArray(procs)
      ? procs.flatMap((p: Record<string, unknown>) => (typeof p?.name === "string" ? [{ name: p.name, pid: typeof p.pid === "number" ? p.pid : null }] : []))
      : [];
    return { shellPid: typeof info.shell_pid === "number" ? info.shell_pid : null, foreground };
  }

  /** Wait until `match` appears in the pane's output. */
  async paneWaitOutput(paneId: string, match: string, timeoutMs: number): Promise<void> {
    await this.call(["pane", "wait-output", paneId, "--match", match, "--timeout", String(timeoutMs)]);
  }

  async paneClose(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }

  async workspaceClose(workspaceId: string): Promise<void> {
    await this.call(["workspace", "close", workspaceId]);
  }

  /** Type a command into a pane's shell and press Enter. */
  async paneRun(paneId: string, command: string): Promise<void> {
    await this.call(["pane", "run", paneId, command]);
  }

  async agentStart(name: string, kind: string, paneId: string, timeoutMs: number, agentArgs: readonly string[] = []): Promise<void> {
    await this.call(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs), ...(agentArgs.length ? ["--", ...agentArgs] : [])]);
  }

  async agentWait(target: string, timeoutMs: number): Promise<void> {
    await this.call(["agent", "wait", target, "--timeout", String(timeoutMs)]);
  }

  async agentList(): Promise<{ paneId: string; status: string; stateChangeSeq: number | null; kind: string | null }[]> {
    const agents: unknown = (await this.call(["agent", "list"])).agents;
    if (!Array.isArray(agents)) throw new HerdrError("unexpected_response", "herdr response is missing agents");
    return agents.flatMap((a: Record<string, unknown>) => typeof a?.pane_id === "string" && typeof a.agent_status === "string"
      ? [{
        paneId: a.pane_id, status: a.agent_status, kind: typeof a.agent === "string" ? a.agent : null,
        stateChangeSeq: typeof a.state_change_seq === "number" ? a.state_change_seq : null,
      }]
      : []);
  }

  async notify(title: string, body: string): Promise<void> {
    await this.call(["notification", "show", title, "--body", body, "--sound", "request"]);
  }

  async agentStatus(target: string): Promise<string | null> {
    const r = await this.call(["agent", "get", target]);
    return typeof r.agent?.agent_status === "string" ? r.agent.agent_status : null;
  }

  async sendKeys(target: string, keys: readonly string[]): Promise<void> {
    await this.call(["agent", "send-keys", target, ...keys]);
  }

  /** The agent's visible screen. The CLI prints plain text, not JSON. */
  async agentRead(target: string): Promise<string> {
    return this.run(["agent", "read", target, "--source", "visible"]);
  }

  /** Submit text to an agent without waiting for it to finish its turn. */
  async prompt(target: string, text: string): Promise<void> {
    await this.call(["agent", "prompt", target, text]);
  }
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

function parse(text: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    return value && typeof value === "object" ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new HerdrError("unexpected_response", `herdr response is missing ${field}`);
  return value;
}
