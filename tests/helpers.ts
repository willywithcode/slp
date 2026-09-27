import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { main } from "../src/cli.js";
import { defaultConfig } from "../src/core/config.js";
import type { Deps } from "../src/core/deps.js";
import { readLedger } from "../src/core/ledger.js";
import { configPath } from "../src/core/paths.js";
import { projectIdFor } from "../src/core/project.js";
import { Herdr, type ExecResult } from "../src/herdr.js";
import { submitCheck } from "../src/letters.js";
import { startRetry } from "../src/seats.js";
import { fold, type State } from "../src/state.js";

// Retries and submission checks must not slow the suite down.
startRetry.delayMs = 1;
submitCheck.waitMs = 30;
submitCheck.pollMs = 5;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
});

export async function tempDir(prefix = "slp-test-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A git repository with one commit on main. */
export async function tempRepo(): Promise<string> {
  const repo = join(await tempDir("slp-repo-"), "app");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "slp test");
  sh(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, "README.md"), "app\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  return repo;
}

export async function commitFile(cwd: string, path: string, content: string, message = `change ${path}`): Promise<void> {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content);
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-q", "-m", message);
}

/** In-memory stand-in for the herdr CLI: allocates IDs and records every call. */
export class FakeHerdrCli {
  calls: string[][] = [];
  prompts: { target: string; text: string }[] = [];
  failPromptFor = new Set<string>();
  /** Live agents by pane id, as `agent list` reports them. */
  agents = new Map<string, { status: string; kind: string; name: string }>();
  panes = new Set<string>(["w1:p0"]);
  tabs = new Set<string>(["w1:t1"]);
  closedPanes: string[] = [];
  closedTabs: string[] = [];
  ran: { pane: string; command: string }[] = [];
  screens = new Map<string, string>();
  notifications: { title: string; body: string }[] = [];
  keys: { target: string; keys: string[] }[] = [];
  /** The process in each pane's foreground; default a POSIX shell. */
  shell = "bash";
  unreachable = false;
  /** Status a prompted agent moves to. */
  promptedStatus = "working";
  private n = 1;

  exec = async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    this.calls.push([...args]);
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ id: "cli", result }), stderr: "" });
    const fail = (code: string) => ({ code: 1, stdout: "", stderr: JSON.stringify({ id: "cli", error: { code, message: `${code} (fake)` } }) });
    if (this.unreachable) return { code: 1, stdout: "", stderr: "Access is denied." };
    const [group, action] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    const newPane = () => { const p = `w1:p${this.n++}`; this.panes.add(p); return p; };
    if (group === "tab" && action === "create") {
      const tab = `w1:t${this.n++}`;
      this.tabs.add(tab);
      return ok({ tab: { tab_id: tab }, root_pane: { pane_id: newPane() } });
    }
    if (group === "tab" && action === "close") { this.closedTabs.push(args[2]!); this.tabs.delete(args[2]!); return ok({}); }
    if (group === "pane" && action === "split") {
      if (!this.panes.has(args[2]!)) return fail("pane_not_found");
      return ok({ pane: { pane_id: newPane() } });
    }
    if (group === "pane" && action === "close") {
      this.closedPanes.push(args[2]!);
      this.panes.delete(args[2]!);
      this.agents.delete(args[2]!);
      return ok({});
    }
    if (group === "pane" && action === "process-info") return ok({ process_info: { foreground_processes: [{ name: this.shell }] } });
    if (group === "pane" && action === "wait-output") return ok({});
    if (group === "pane" && action === "run") { this.ran.push({ pane: args[2]!, command: args[3]! }); return ok({}); }
    if (group === "agent" && action === "start") {
      const pane = flag("--pane");
      if (!this.panes.has(pane)) return fail("pane_not_found");
      this.agents.set(pane, { status: "idle", kind: flag("--kind"), name: args[2]! });
      return ok({});
    }
    if (group === "agent" && action === "prompt") {
      if (this.failPromptFor.has(args[2]!)) return fail("agent_blocked");
      if (!this.agents.has(args[2]!)) return fail("agent_not_found");
      this.prompts.push({ target: args[2]!, text: args[3]! });
      this.agents.get(args[2]!)!.status = this.promptedStatus;
      return ok({});
    }
    if (group === "agent" && action === "get") {
      const a = this.agents.get(args[2]!);
      return a ? ok({ agent: { pane_id: args[2], agent_status: a.status, agent: a.kind } }) : fail("agent_not_found");
    }
    if (group === "agent" && action === "list") {
      return ok({ agents: [...this.agents].map(([pane_id, a]) => ({ pane_id, agent_status: a.status, agent: a.kind, state_change_seq: 1 })) });
    }
    if (group === "agent" && action === "read") return { code: 0, stdout: this.screens.get(args[2]!) ?? "> ready", stderr: "" };
    if (group === "agent" && action === "send-keys") { this.keys.push({ target: args[2]!, keys: args.slice(3) }); return ok({}); }
    if (group === "notification" && action === "show") {
      this.notifications.push({ title: args[2]!, body: flag("--body") });
      return ok({});
    }
    return fail("unsupported_in_fake");
  };

  /** Every agent finishes its turn. */
  idleAll(): void {
    for (const a of this.agents.values()) a.status = "idle";
  }

  promptsTo(pane: string): string[] {
    return this.prompts.filter((p) => p.target === pane).map((p) => p.text);
  }
}

/** One test world: a repository, SLP_HOME, a fake Herdr, and the Human's pane w1:p0. */
export class World {
  out: string[] = [];
  constructor(readonly home: string, readonly repo: string, readonly cli: FakeHerdrCli) {}

  static async create(): Promise<World> {
    const home = await tempDir("slp-home-");
    const repo = await tempRepo();
    await mkdir(dirname(configPath({ SLP_HOME: home })), { recursive: true });
    await writeFile(configPath({ SLP_HOME: home }), JSON.stringify(defaultConfig("linux")));
    return new World(home, repo, new FakeHerdrCli());
  }

  get project(): string { return projectIdFor(this.repo); }

  deps(pane: string | null = "w1:p0", now?: () => number): Deps {
    return {
      env: { SLP_HOME: this.home, HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", ...(pane ? { HERDR_PANE_ID: pane } : {}) },
      herdr: new Herdr(this.cli.exec, "herdr"),
      out: (line) => { this.out.push(line); },
      ...(now ? { now } : {}),
    };
  }

  /** Run slp as the Human (default) or as whoever sits in `pane`. */
  async slp(argv: string[], pane: string | null = "w1:p0", stdin = ""): Promise<number> {
    return main(argv, this.deps(pane), this.repo, async () => Buffer.from(stdin));
  }

  async state(): Promise<State> {
    return fold(await readLedger({ SLP_HOME: this.home }, this.project));
  }

  async pane(seat: string): Promise<string> {
    const s = (await this.state()).seats.get(seat);
    if (!s) throw new Error(`no seat ${seat}`);
    return s.paneId;
  }

  /** Run a verb as a seat, by name. */
  async as(seat: string, argv: string[], stdin = ""): Promise<number> {
    return this.slp(argv, await this.pane(seat), stdin);
  }

  /** Letters the seat's pane received, newest last. */
  async inbox(seat: string): Promise<string[]> {
    return this.cli.promptsTo(await this.pane(seat));
  }
}
