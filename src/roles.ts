import type { Agent } from "./core/config.js";
import type { Role } from "./core/ledger.js";

// Roles are data (ADR 0007): what each may do through slp, and how its agent
// is launched. The authority rules themselves live in each role's guide.

export interface RoleSpec {
  /** Verbs this role may run through slp. */
  verbs: readonly string[];
  /** Read and reported on by the watch (ADR 0009). */
  watched: boolean;
  /** May not change files. */
  readOnly: boolean;
  /** May write the project's CONTEXT.md (`slp context -`). */
  editsContext: boolean;
}

const COMMON = ["guide", "whoami", "status", "context"] as const;

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  supervisor: {
    verbs: [...COMMON, "message", "open-lane", "amend-lane", "close-lane", "set-project", "answer", "incidents", "ack", "move-seat"],
    watched: false, readOnly: true, editsContext: true,
  },
  lead: {
    verbs: [...COMMON, "message", "start-task", "start-review", "accept", "rework", "cut", "report", "ask", "answer", "incidents", "ack", "diff"],
    watched: true, readOnly: true, editsContext: false,
  },
  peer: { verbs: [...COMMON, "done", "ask"], watched: true, readOnly: false, editsContext: false },
  reviewer: { verbs: [...COMMON, "done", "ask", "diff"], watched: false, readOnly: true, editsContext: false },
  critic: { verbs: [...COMMON, "findings"], watched: false, readOnly: true, editsContext: false },
};

export function mayRun(role: Role, verb: string): boolean {
  return ROLE_SPECS[role].verbs.includes(verb);
}

export interface LaunchContext {
  role: Role;
  model: string | null;
  effort: string | null;
  /** Claude: fixed transcript id (ADR 0009). */
  sessionId: string | null;
  /** Codex: a directory unique to this seat, found in its rollout metadata. */
  markerDir: string | null;
  slpHome: string;
  projectDir: string;
  /** More directories the agent must write to (a worktree's git directory). */
  writableDirs?: readonly string[];
}

/** Native arguments for `herdr agent start -- <args>`. */
export function agentArgs(agent: Agent, c: LaunchContext): string[] {
  const spec = ROLE_SPECS[c.role];
  if (agent === "claude") {
    const args = [
      ...(c.model ? ["--model", c.model] : []),
      ...(c.effort ? ["--effort", c.effort] : []),
      ...(c.sessionId ? ["--session-id", c.sessionId] : []),
      // ADR 0004: only slp runs without a prompt; everything else still asks.
      "--allowedTools", "Bash(slp *)", "Bash(slp.cmd *)",
    ];
    if (spec.readOnly && c.role !== "supervisor" && c.role !== "lead") {
      args.push("--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit");
    }
    return args;
  }
  if (agent === "codex") {
    return [
      // ADR 0004: own process (sees its pane's HERDR_PANE_ID); workspace-write
      // so --add-dir is honoured and a Peer can edit code.
      "--no-daemon", "--sandbox", "workspace-write",
      ...(c.model ? ["-m", c.model] : []),
      ...(c.effort ? ["-c", `model_reasoning_effort=${c.effort}`] : []),
      "--add-dir", c.slpHome,
      ...(c.markerDir ? ["--add-dir", c.markerDir] : []),
      ...(c.writableDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ];
  }
  return [...(c.model ? ["--model", c.model] : []), ...(c.effort ? ["--effort", c.effort] : [])];
}
