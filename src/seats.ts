import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chooseSeat, expandHome, type Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, readLedger, type Role } from "./core/ledger.js";
import { projectDir, slpHome } from "./core/paths.js";
import type { Project } from "./core/project.js";
import { HerdrError } from "./herdr.js";
import { describe, sendLetter } from "./letters.js";
import { agentArgs } from "./roles.js";
import { envCommands, joinCommands, readyProbe, shellFamily, type ShellFamily } from "./shells.js";
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
  /** Text of the INTRO letter sent once the agent is up. */
  intro: string;
}

export interface Opened { seat: Seat; attention: string | null }

/** Startup screens only the Human may answer (Claude Code, Codex). */
const STARTUP_DIALOG = /trust this folder|do you trust|one you trust|trust the files|trust and continue/i;

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

  const ready = (pane: string) => prepare(deps, pane, choice.launcher.env, choice.launcher.prep);
  await ready(paneId);
  const sessionId = choice.launcher.agent === "claude" ? randomUUID() : null;
  let marker: string | null = null;
  if (choice.launcher.agent === "codex") {
    marker = join(projectDir(deps.env, project.id), "seats", spec.name);
    await mkdir(marker, { recursive: true });
  }
  const args = agentArgs(choice.launcher.agent, {
    role: spec.role, model: choice.model, effort: choice.effort, sessionId, markerDir: marker,
    slpHome: slpHome(deps.env), projectDir: projectDir(deps.env, project.id), writableDirs: spec.writableDirs ?? [],
  });
  const name = herdrName(project.id, spec.name);
  paneId = await startAgent(deps, name, choice.launcher.agent, paneId, args, { cwd: spec.cwd, env: paneEnv, ready });

  const event = await append(deps.env, project.id, () => ({
    kind: "seat" as const, name: spec.name, role: spec.role, lane: spec.lane, task: spec.task,
    launcher: choice.launcherName, agent: choice.launcher.agent, model: choice.model, effort: choice.effort,
    paneId, tabId, sessionId, marker,
  }));
  const seat = fold(await readLedger(deps.env, project.id)).seats.get(event.name)!;

  // Herdr may report an agent ready while a folder-trust dialog is shown; the
  // letter's Enter would then accept it on the Human's behalf. Never.
  const screen = await deps.herdr.agentRead(paneId).catch(() => "");
  if (STARTUP_DIALOG.test(screen)) {
    return { seat, attention: `${spec.name} waits on a folder-trust dialog in pane ${paneId}; answer it, then run \`slp intro ${spec.name}\`.` };
  }
  try {
    await sendLetter(deps, project.id, { letter: "INTRO", from: "slp", to: spec.name, text: spec.intro, lane: spec.lane, task: spec.task });
  } catch (error) {
    return { seat, attention: `${spec.name} is open but its introduction was not delivered (${describe(error)}).` };
  }
  deps.out(`${spec.name}: ${choice.launcher.agent} (${choice.launcherName}${choice.model ? `, ${choice.model}` : ""}${choice.effort ? ` ${choice.effort}` : ""}) in ${paneId}`);
  return { seat, attention: null };
}

/** Set the launcher's environment and run its preparation in the pane's own shell. */
async function prepare(deps: Deps, paneId: string, env: Record<string, string | null>, prep: { powershell?: string | undefined; sh?: string | undefined }): Promise<void> {
  const expanded = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === null ? null : expandHome(v)]));
  if (!Object.keys(expanded).length && !prep.powershell && !prep.sh) return;
  const family = await detectShell(deps, paneId);
  const extra = family === "powershell" ? prep.powershell : family === "sh" ? prep.sh : undefined;
  if ((prep.powershell || prep.sh) && !extra) throw new SlpError(`This launcher has no preparation for a ${family} shell (pane ${paneId}).`);
  const nonce = randomUUID().slice(0, 8);
  const probe = readyProbe(family, nonce);
  await deps.herdr.paneRun(paneId, joinCommands(family, [...envCommands(family, expanded), ...(extra ? [extra] : []), probe.command]));
  await deps.herdr.paneWaitOutput(paneId, probe.match, 30_000);
}

export async function detectShell(deps: Deps, paneId: string): Promise<ShellFamily> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const family = shellFamily(await deps.herdr.paneForeground(paneId).catch(() => []));
    if (family) return family;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SlpError(`Could not tell which shell runs in pane ${paneId}.`);
}

/**
 * `herdr agent start`, retrying a pane whose shell is not ready yet; a pane
 * that stays occupied (seen live: a stray process attached to a new pane) is
 * replaced by a fresh one beside it. Returns the pane the agent runs in.
 */
async function startAgent(deps: Deps, name: string, agent: string, paneId: string, args: string[],
  fresh: { cwd: string; env: Record<string, string>; ready: (pane: string) => Promise<void> }): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.herdr.agentStart(name, agent, paneId, 60_000, args);
      return paneId;
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
      if (attempt < startRetry.attempts) {
        await new Promise((resolve) => setTimeout(resolve, startRetry.delayMs));
        continue;
      }
    }
    const other = await deps.herdr.paneSplit(paneId, { direction: "down", cwd: fresh.cwd, env: fresh.env });
    deps.out(`pane ${paneId} is occupied; using ${other}`);
    // The new pane's shell needs the account's environment too.
    await fresh.ready(other);
    await deps.herdr.agentStart(name, agent, other, 60_000, args);
    return other;
  }
}

/** Close a seat's pane and record it. */
export async function closeSeat(deps: Deps, project: string, seat: Seat, reason: string): Promise<void> {
  await deps.herdr.paneClose(seat.paneId).catch(() => undefined);
  await append(deps.env, project, () => ({ kind: "seat-stop" as const, name: seat.name, reason }));
}
