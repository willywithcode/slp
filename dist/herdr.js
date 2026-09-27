import { execFile } from "node:child_process";
export class HerdrError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const defaultExec = (file, args) => new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
    });
});
/** Thin typed wrapper over the `herdr` CLI. Every call returns herdr's JSON `result`. */
export class Herdr {
    exec;
    bin;
    constructor(exec = defaultExec, bin = process.env.HERDR_BIN_PATH || "herdr") {
        this.exec = exec;
        this.bin = bin;
    }
    async call(args) {
        return parse(await this.run(args))?.result ?? {};
    }
    /** Run a command and return its stdout; errors are herdr's JSON on stderr. */
    async run(args) {
        const { code, stdout, stderr } = await this.exec(this.bin, args);
        if (code !== 0) {
            const body = parse(stderr) ?? parse(stdout);
            const error = body?.error;
            if (error && typeof error.code === "string")
                throw new HerdrError(error.code, String(error.message ?? error.code));
            throw new HerdrError("cli_failed", (stderr || stdout).trim() || `herdr exited with ${code}`);
        }
        return stdout;
    }
    async workspaceCreate(opts) {
        const r = await this.call(["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, ...envArgs(opts.env), "--no-focus"]);
        return { workspaceId: required(r.workspace?.workspace_id, "workspace_id"), rootPaneId: required(r.root_pane?.pane_id, "root_pane.pane_id") };
    }
    async paneSplit(paneId, opts) {
        const r = await this.call(["pane", "split", paneId, "--direction", opts.direction, "--cwd", opts.cwd, ...envArgs(opts.env), "--no-focus"]);
        return required(r.pane?.pane_id, "pane.pane_id");
    }
    async paneClose(paneId) {
        await this.call(["pane", "close", paneId]);
    }
    async workspaceClose(workspaceId) {
        await this.call(["workspace", "close", workspaceId]);
    }
    /** Type a command into a pane's shell and press Enter. */
    async paneRun(paneId, command) {
        await this.call(["pane", "run", paneId, command]);
    }
    async agentStart(name, kind, paneId, timeoutMs, agentArgs = []) {
        await this.call(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs), ...(agentArgs.length ? ["--", ...agentArgs] : [])]);
    }
    async agentWait(target, timeoutMs) {
        await this.call(["agent", "wait", target, "--timeout", String(timeoutMs)]);
    }
    async agentList() {
        const agents = (await this.call(["agent", "list"])).agents;
        if (!Array.isArray(agents))
            throw new HerdrError("unexpected_response", "herdr response is missing agents");
        return agents.flatMap((a) => typeof a?.pane_id === "string" && typeof a.agent_status === "string"
            ? [{
                    paneId: a.pane_id, status: a.agent_status, kind: typeof a.agent === "string" ? a.agent : null,
                    stateChangeSeq: typeof a.state_change_seq === "number" ? a.state_change_seq : null,
                }]
            : []);
    }
    async notify(title, body) {
        await this.call(["notification", "show", title, "--body", body, "--sound", "request"]);
    }
    async agentStatus(target) {
        const r = await this.call(["agent", "get", target]);
        return typeof r.agent?.agent_status === "string" ? r.agent.agent_status : null;
    }
    async sendKeys(target, keys) {
        await this.call(["agent", "send-keys", target, ...keys]);
    }
    /** The agent's visible screen. The CLI prints plain text, not JSON. */
    async agentRead(target) {
        return this.run(["agent", "read", target, "--source", "visible"]);
    }
    /** Submit text to an agent without waiting for it to finish its turn. */
    async prompt(target, text) {
        await this.call(["agent", "prompt", target, text]);
    }
}
function envArgs(env) {
    return Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}
function parse(text) {
    try {
        const value = JSON.parse(text.trim());
        return value && typeof value === "object" ? value : null;
    }
    catch {
        return null;
    }
}
function required(value, field) {
    if (typeof value !== "string" || !value)
        throw new HerdrError("unexpected_response", `herdr response is missing ${field}`);
    return value;
}
