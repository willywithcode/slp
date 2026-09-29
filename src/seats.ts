import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chooseSeat, expandHome, type Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, readLedger, type LetterKind, type Role } from "./core/ledger.js";
import { projectDir, slpHome } from "./core/paths.js";
import type { Project } from "./core/project.js";
import { HerdrError } from "./herdr.js";
import { atStartupDialog, describe, queueLetter, recordUndelivered, sendLetter, watchLockPath } from "./letters.js";
import { lockHeldByLiveProcess } from "./core/lock.js";
import { agentArgs } from "./roles.js";
import { commandLine, envCommands, joinCommands, pathPrepend, readyProbe, shellFamily, type ShellFamily } from "./shells.js";
import { writeClaudeSettings, writeGitShim } from "./permissions.js";
import { fold, type Seat } from "./state.js";

// Seats are opened only through Herdr (ADR 0012): a pane (split or new tab in
// the Human's workspace), the launcher's environment and preparation typed
// into that pane's own shell, then `herdr agent start`.

export type Placement =
  | { kind: "split"; from: string; direction: "right" | "down" }
  | { kind: "tab"; label: string };

export interface SeatSpec {
  name: string;
  role: Role;
  lane: string | null;
  task: string | null;
  cwd: string;
  place: Placement;
  /** A named choice from the role's presets (Peers: sol, luna, flash). */
  preset?: string | null;
  /** More directories the agent must write to (codex sandbox). */
  writableDirs?: readonly string[];
  /** Who the seat is and where to start (`intro()`). */
  intro: string;
  /**
   * The seat's work, sent with its introduction as one first letter, so it
   * never starts without it (seen live: a Critic went looking for its brief).
   */
  brief?: { letter: LetterKind; from: string; text: string };
}

export interface Opened { seat: Seat; attention: string | null }


/** Retries while a fresh pane's shell is not ready; mutable only for tests. */
export const startRetry = { attempts: 6, delayMs: 1_000 };

export function herdrName(project: string, seat: string): string {
  return `${project.slice(0, 14)}-${seat}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "s").slice(0, 32);
}

export async function openSeat(deps: Deps, project: Project, config: Config, spec: SeatSpec): Promise<Opened> {
  if (!project.workspaceId) throw new SlpError("The team has no workspace yet; run `slp start` first.");
  const events = await readLedger(deps.env, project.id);
  const state = fold(events);
  const existing = state.seats.get(spec.name);
  if (existing?.live) throw new SlpError(`Seat ${spec.name} is already open in pane ${existing.paneId}`);
  const opened = new Set(events.flatMap((e) => (e.kind === "seat" && e.role === spec.role ? [e.name] : []))).size;
  const choice = chooseSeat(config, spec.role, opened, spec.preset);
  const paneEnv = { SLP_PROJECT: project.id };

  let tabId: string;
  let paneId: string;
  if (spec.place.kind === "tab") {
    const t = await deps.herdr.tabCreate({ workspaceId: project.workspaceId, cwd: spec.cwd, label: spec.place.label, env: paneEnv });
    tabId = t.tabId;
    paneId = t.rootPaneId;
  } else {
    const from = spec.place.from;
    paneId = await deps.herdr.paneSplit(from, { direction: spec.place.direction, cwd: spec.cwd, env: paneEnv });
    // A split stays in the tab of the pane it came from: a seat's, or the Human's main tab.
    tabId = [...state.seats.values()].find((s) => s.paneId === from)?.tabId ?? project.mainTabId ?? "";
  }

  const shimDir = await writeGitShim(deps.env, spec.role);
  const settingsPath = choice.launcher.agent === "claude" ? await writeClaudeSettings(deps.env, spec.role, config) : null;
  const ready = (pane: string) => prepare(deps, pane, choice.launcher.env, choice.launcher.prep, shimDir);
  const family = await ready(paneId);
  const sessionId = choice.launcher.agent === "claude" ? randomUUID() : null;
  let marker: string | null = null;
  if (choice.launcher.agent === "codex") {
    marker = join(projectDir(deps.env, project.id), "seats", spec.name);
    await mkdir(marker, { recursive: true });
  }
  const args = agentArgs(choice.launcher.agent, {
    role: spec.role, model: choice.model, effort: choice.effort, sessionId, markerDir: marker,
    slpHome: slpHome(deps.env), projectDir: projectDir(deps.env, project.id), writableDirs: spec.writableDirs ?? [], settingsPath,
  });
  const name = herdrName(project.id, spec.name);
  const started = await startAgent(deps, name, choice.launcher.agent, paneId, args, { cwd: spec.cwd, env: paneEnv, ready, command: choice.launcher.command ?? null, family });
  paneId = started.paneId;

  const event = await append(deps.env, project.id, () => ({
    kind: "seat" as const, name: spec.name, role: spec.role, lane: spec.lane, task: spec.task,
    launcher: choice.launcherName, agent: choice.launcher.agent, model: choice.model, effort: choice.effort,
    paneId, tabId, sessionId, marker,
  }));
  const seat = fold(await readLedger(deps.env, project.id)).seats.get(event.name)!;

  // Herdr may report an agent ready while a folder-trust dialog is shown; the
  // letter's Enter would then accept it on the Human's behalf. Never.
  const first = {
    letter: spec.brief?.letter ?? "INTRO" as LetterKind, from: spec.brief?.from ?? "slp", to: spec.name,
    text: spec.brief ? `${spec.intro}\n\n${spec.brief.text}` : spec.intro, lane: spec.lane, task: spec.task,
  };
  if (started.blocked || await atStartupDialog(deps, paneId)) {
    // With a watcher, the first letter (and anything sent after it) waits
    // until the agent is ready; without one the Human resends it.
    const watched = await lockHeldByLiveProcess(watchLockPath(deps.env, project.id));
    if (watched) await queueLetter(deps, project.id, first);
    else await recordUndelivered(deps, project.id, first, "startup dialog on screen");
    const then = watched ? "slp introduces it once it is ready" : `then run \`slp intro ${spec.name}\``;
    await deps.herdr.notify(`slp: ${spec.name} needs you`, `Answer the startup dialog in pane ${paneId}; ${then}.`).catch(() => undefined);
    return { seat, attention: `${spec.name} waits on a startup dialog (folder trust) in pane ${paneId}; answer it yourself; ${then}.` };
  }
  try {
    await sendLetter(deps, project.id, first);
  } catch (error) {
    return { seat, attention: `${spec.name} is open but its introduction was not delivered (${describe(error)}).` };
  }
  deps.out(`${spec.name}: ${choice.launcher.agent} (${choice.launcherName}${choice.model ? `, ${choice.model}` : ""}${choice.effort ? ` ${choice.effort}` : ""}) in ${paneId}`);
  return { seat, attention: null };
}

/** Set the launcher's environment and run its preparation in the pane's own shell. */
async function prepare(deps: Deps, paneId: string, env: Record<string, string | null>, prep: { powershell?: string | undefined; sh?: string | undefined },
  shimDir: string): Promise<ShellFamily> {
  const expanded = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === null ? null : expandHome(v)]));
  const family = await detectShell(deps, paneId);
  const extra = family === "powershell" ? prep.powershell : family === "sh" ? prep.sh : undefined;
  if ((prep.powershell || prep.sh) && !extra) throw new SlpError(`This launcher has no preparation for a ${family} shell (pane ${paneId}).`);
  const nonce = randomUUID().slice(0, 8);
  const probe = readyProbe(family, nonce);
  // The role's git shim goes first on PATH (ADR 0016).
  await deps.herdr.paneRun(paneId, joinCommands(family, [pathPrepend(family, shimDir), ...envCommands(family, expanded), ...(extra ? [extra] : []), probe.command]));
  await deps.herdr.paneWaitOutput(paneId, probe.match, 30_000);
  return family;
}

/** The name of a local process (Herdr runs on this machine), or null. */
export type ProcessName = (pid: number) => Promise<string | null>;

export const processName: ProcessName = (pid) => new Promise((resolve) => {
  const [file, args] = process.platform === "win32"
    ? ["tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]]
    : ["ps", ["-p", String(pid), "-o", "comm="]];
  execFile(file, args, { windowsHide: true }, (error, stdout) => {
    if (error) return resolve(null);
    const out = String(stdout).trim();
    const name = process.platform === "win32" ? /^"([^"]+)"/.exec(out)?.[1] : out.split("/").pop();
    resolve(name || null);
  });
});

/** Replaceable in tests. */
export const shellLookup = { processName };

/**
 * Which shell runs in a pane: the pane's own shell process when Herdr names
 * it, else what Herdr sees in the foreground (a fresh pane shows its shell).
 */
export async function detectShell(deps: Deps, paneId: string): Promise<ShellFamily> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const info = await deps.herdr.paneProcesses(paneId).catch(() => null);
    if (info) {
      const own = info.foreground.find((p) => p.pid !== null && p.pid === info.shellPid)?.name
        ?? (info.shellPid !== null ? await shellLookup.processName(info.shellPid) : null);
      const family = shellFamily(own ? [own] : info.foreground.map((p) => p.name));
      if (family) return family;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SlpError(`Could not tell which shell runs in pane ${paneId}.`);
}

/** Herdr's refusal when the agent shows a dialog (folder trust) before it is ready. */
function blockedAtStartup(error: unknown): boolean {
  return error instanceof HerdrError && /blocked during startup/i.test(error.message);
}

/**
 * `herdr agent start`, retrying a pane whose shell is not ready yet; a pane
 * that stays occupied (seen live: a stray process attached to a new pane) is
 * replaced by a fresh one beside it. An agent stopped at a startup dialog is
 * running: it is recorded and left for the Human to answer.
 */
async function startAgent(deps: Deps, name: string, agent: string, paneId: string, args: string[],
  fresh: { cwd: string; env: Record<string, string>; ready: (pane: string) => Promise<ShellFamily>; command: string | null; family: ShellFamily }): Promise<{ paneId: string; blocked: boolean }> {
  let family = fresh.family;
  const attempt = async (pane: string) => {
    // A launcher's own command (e.g. claude-as acc1) is typed into the shell; Herdr then sees the agent.
    if (fresh.command) return startByCommand(deps, pane, commandLine(family, fresh.command, args));
    try {
      await deps.herdr.agentStart(name, agent, pane, 60_000, args);
      return { paneId: pane, blocked: false };
    } catch (error) {
      if (blockedAtStartup(error)) return { paneId: pane, blocked: true };
      throw error;
    }
  };
  for (let n = 1; ; n++) {
    try {
      return await attempt(paneId);
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
      if (n < startRetry.attempts) {
        await new Promise((resolve) => setTimeout(resolve, startRetry.delayMs));
        continue;
      }
    }
    const other = await deps.herdr.paneSplit(paneId, { direction: "down", cwd: fresh.cwd, env: fresh.env });
    deps.out(`pane ${paneId} is occupied; using ${other}`);
    // The new pane's shell needs the account's environment too.
    family = await fresh.ready(other);
    return attempt(other);
  }
}

/** Close a seat's pane and record it. */
export async function closeSeat(deps: Deps, project: string, seat: Seat, reason: string): Promise<void> {
  await deps.herdr.paneClose(seat.paneId).catch(() => undefined);
  await append(deps.env, project, () => ({ kind: "seat-stop" as const, name: seat.name, reason }));
}

/**
 * Move a seat to another account (ADR 0011): a new pane beside it prepared
 * for the other launcher, the old pane closed, and the same session resumed
 * there. Only when the Supervisor (for the Human) asks; slp never switches
 * accounts on its own.
 */
export async function moveSeat(deps: Deps, project: Project, config: Config, seat: Seat,
  move: { launcher: string; cwd: string; resume: string; writableDirs: readonly string[] }): Promise<Opened> {
  const launcher = config.launchers[move.launcher];
  if (!launcher) throw new SlpError(`No launcher "${move.launcher}" (known: ${Object.keys(config.launchers).join(", ")})`);
  if (launcher.agent !== seat.agent) throw new SlpError(`${seat.name} runs ${seat.agent}; ${move.launcher} runs ${launcher.agent}. A session can only move within one agent.`);
  if (move.launcher === seat.launcher) throw new SlpError(`${seat.name} already runs on ${move.launcher}.`);
  const paneEnv = { SLP_PROJECT: project.id };
  const paneId = await deps.herdr.paneSplit(seat.paneId, { direction: "down", cwd: move.cwd, env: paneEnv });
  const shimDir = await writeGitShim(deps.env, seat.role);
  const settingsPath = launcher.agent === "claude" ? await writeClaudeSettings(deps.env, seat.role, config) : null;
  const ready = (pane: string) => prepare(deps, pane, launcher.env, launcher.prep, shimDir);
  const family = await ready(paneId);
  const args = agentArgs(launcher.agent, {
    role: seat.role, model: seat.model, effort: seat.effort, sessionId: null, resume: move.resume, markerDir: seat.marker,
    slpHome: slpHome(deps.env), projectDir: projectDir(deps.env, project.id), writableDirs: move.writableDirs, settingsPath,
  });
  // The old agent goes first: one agent per session, and Herdr names are unique.
  await deps.herdr.paneClose(seat.paneId).catch(() => undefined);
  let started: { paneId: string; blocked: boolean };
  try {
    started = await startAgent(deps, herdrName(project.id, seat.name), launcher.agent, paneId, args, { cwd: move.cwd, env: paneEnv, ready, command: launcher.command ?? null, family });
  } catch (error) {
    await append(deps.env, project.id, () => ({ kind: "seat-stop" as const, name: seat.name, reason: `move to ${move.launcher} failed: ${describe(error)}` }));
    // The old agent is already closed (one agent per session), so the seat is gone.
    throw new SlpError(`Moving ${seat.name} to ${move.launcher} failed (${describe(error)}); its old pane was already closed. ` +
      (seat.task ? `Its Lead cuts ${seat.task} and starts it again.` : "Open the seat again (for a Lead: drop and reopen the lane, or ask the Human)."));
  }
  await append(deps.env, project.id, () => ({
    kind: "seat" as const, name: seat.name, role: seat.role, lane: seat.lane, task: seat.task, launcher: move.launcher,
    agent: seat.agent, model: seat.model, effort: seat.effort, paneId: started.paneId, tabId: seat.tabId,
    sessionId: seat.sessionId, marker: seat.marker,
  }));
  const moved = fold(await readLedger(deps.env, project.id)).seats.get(seat.name)!;
  const notice = { letter: "NOTICE" as const, from: "slp", to: seat.name, lane: seat.lane, task: seat.task,
    text: `This session was moved to another account (${move.launcher}). Carry on where you left off.` };
  if (started.blocked || await atStartupDialog(deps, started.paneId)) {
    await queueLetter(deps, project.id, notice);
    return { seat: moved, attention: `${seat.name} waits on a startup dialog in pane ${started.paneId}; answer it yourself.` };
  }
  await sendLetter(deps, project.id, notice).catch(() => undefined);
  deps.out(`${seat.name} moved to ${move.launcher} in ${started.paneId}`);
  return { seat: moved, attention: null };
}

/** How long a launcher's own command may take to bring its agent up; mutable for tests. */
export const commandStart = { timeoutMs: 60_000, pollMs: 500 };

/**
 * Type the launcher's command into the pane's shell and wait until Herdr sees
 * the agent there (it recognises agents by their process, however started).
 */
async function startByCommand(deps: Deps, pane: string, line: string): Promise<{ paneId: string; blocked: boolean }> {
  await deps.herdr.paneRun(pane, line);
  const deadline = Date.now() + commandStart.timeoutMs;
  for (;;) {
    const status = await deps.herdr.agentStatus(pane).catch(() => null);
    if (status === "blocked") return { paneId: pane, blocked: true };
    if (status === "idle" || status === "done" || status === "working") return { paneId: pane, blocked: false };
    if (Date.now() >= deadline) {
      const shown = (await deps.herdr.paneRead(pane, 15).catch(() => "")).trim();
      throw new SlpError(`No agent started in pane ${pane} from: ${line}` + (shown ? `
The pane shows:
${shown}` : ""));
    }
    await new Promise((resolve) => setTimeout(resolve, commandStart.pollMs));
  }
}
