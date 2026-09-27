const COMMON = ["guide", "whoami", "status", "context"];
export const ROLE_SPECS = {
    supervisor: {
        verbs: [...COMMON, "message", "open-lane", "amend-lane", "close-lane", "set-project", "answer", "incidents", "ack", "move-seat"],
        watched: false, readOnly: true, editsContext: true,
    },
    lead: {
        verbs: [...COMMON, "message", "start-task", "start-review", "accept", "rework", "cut", "report", "ask", "answer", "incidents", "ack", "diff", "test"],
        watched: true, readOnly: true, editsContext: false,
    },
    peer: { verbs: [...COMMON, "done", "ask"], watched: true, readOnly: false, editsContext: false },
    reviewer: { verbs: [...COMMON, "done", "ask", "diff", "test"], watched: false, readOnly: true, editsContext: false },
    critic: { verbs: [...COMMON, "findings"], watched: false, readOnly: true, editsContext: false },
};
export function mayRun(role, verb) {
    return ROLE_SPECS[role].verbs.includes(verb);
}
/** Native arguments for `herdr agent start -- <args>`. */
export function agentArgs(agent, c) {
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
