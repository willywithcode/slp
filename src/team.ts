import { stat, writeFile } from "node:fs/promises";
import type { Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger } from "./core/ledger.js";
import { lockHeldByLiveProcess } from "./core/lock.js";
import { contextPath, ensureProject, saveProject, type Project } from "./core/project.js";
import { detectGate } from "./gate.js";
import { toplevel } from "./git.js";
import { intro } from "./guide.js";
import { pendingRequests } from "./land.js";
import { dropLane } from "./lanes.js";
import { sendLetter, watchLockPath } from "./letters.js";
import { closeSeat, detectShell, openSeat } from "./seats.js";
import { fold, liveSeats, type State } from "./state.js";
import type { Actor } from "./tasks.js";

// The Human's commands (start, stop, status) and the Supervisor's lane
// closing and project settings.

const CONTEXT_TEMPLATE = `# Concept

The Human's settled answers about what this project is and how it behaves.
The Supervisor keeps it short and current; nobody else edits it.

## What it is

## Terms

## How it behaves

## What it does not do
`;

/** How long `slp start` waits for its watcher to take the watch lock; mutable for tests. */
export const watchStartMs = { value: 15_000 };

/** Start the team in the Human's own Herdr pane (ADR 0012): Supervisor to the right, watcher below. */
export async function start(deps: Deps, cwd: string, config: Config): Promise<Project> {
  const pane = deps.env.HERDR_PANE_ID;
  const workspace = deps.env.HERDR_WORKSPACE_ID;
  if (!pane || !workspace) throw new SlpError("Run `slp start` in a Herdr pane: the team opens beside you in this workspace.");
  if (!(await toplevel(cwd))) throw new SlpError("slp works on a git repository; run `slp start` inside one.");
  let project = await ensureProject(deps.env, cwd);
  let state = fold(await readLedger(deps.env, project.id));
  const agents = await deps.herdr.agentList();
  const running = new Set(agents.map((a) => a.paneId));
  const sup = state.seats.get("sup");
  if (sup?.live && running.has(sup.paneId)) throw new SlpError(`The team is already running here (Supervisor in pane ${sup.paneId}).`);
  // Seats of an earlier session whose panes are gone.
  for (const seat of liveSeats(state)) {
    if (!running.has(seat.paneId)) await append(deps.env, project.id, () => ({ kind: "seat-stop" as const, name: seat.name, reason: "gone before start" }));
  }
  project = { ...project, workspaceId: workspace, mainTabId: deps.env.HERDR_TAB_ID ?? null, humanPane: pane };
  await saveProject(deps.env, project);
  if (!(await stat(contextPath(deps.env, project.id)).then(() => true, () => false))) {
    await writeFile(contextPath(deps.env, project.id), CONTEXT_TEMPLATE, "utf8");
  }
  if (state.settings.gate === null) {
    const gate = await detectGate(project.root);
    if (gate) {
      await append(deps.env, project.id, () => ({ ...state.settings, kind: "project" as const, gate }));
      deps.out(`gate: ${gate} (change with the Supervisor: slp set-project --gate "...")`);
    }
  }

  if (!(await lockHeldByLiveProcess(watchLockPath(deps.env, project.id)))) {
    const watchPane = await deps.herdr.paneSplit(pane, { direction: "down", cwd: project.root, env: { SLP_PROJECT: project.id } });
    const family = await detectShell(deps, watchPane);
    const bin = family === "powershell" || family === "cmd" ? "slp.cmd" : "slp";
    await deps.herdr.paneRun(watchPane, `${bin} watch --project ${project.id}`);
    project = { ...project, watchPane };
    await saveProject(deps.env, project);
    // Seats opened next rely on it (queued letters), so wait until it runs.
    const deadline = Date.now() + watchStartMs.value;
    while (!(await lockHeldByLiveProcess(watchLockPath(deps.env, project.id))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    deps.out(`watcher: pane ${watchPane}`);
  }
  const opened = await openSeat(deps, project, config, {
    name: "sup", role: "supervisor", lane: null, task: null, cwd: project.root,
    place: { kind: "split", from: pane, direction: "right" },
    intro: intro("sup", "supervisor", ` for ${project.root}`, "claude"),
  });
  if (opened.attention) deps.out(`NEEDS ATTENTION: ${opened.attention}`);
  state = fold(await readLedger(deps.env, project.id));
  deps.out(`slp team for ${project.root} (${project.id}): talk to the Supervisor in pane ${opened.seat.paneId}.`);
  deps.out(`concept: ${contextPath(deps.env, project.id)}`);
  return project;
}

export async function stop(deps: Deps, project: Project, state: State, force: boolean): Promise<void> {
  const open = [...state.lanes.values()].filter((l) => l.open);
  if (open.length && !force) {
    throw new SlpError(`Open lanes: ${open.map((l) => l.id).join(", ")}. Have the Supervisor close them, or \`slp stop --force\` ` +
      "(the lanes stay open in the record; their branches and worktrees are kept).");
  }
  const tabs = new Set<string>();
  for (const seat of liveSeats(state)) {
    if (seat.tabId && seat.tabId !== project.mainTabId) tabs.add(seat.tabId);
    await closeSeat(deps, project.id, seat, "team stopped");
  }
  for (const tab of tabs) await deps.herdr.tabClose(tab).catch(() => undefined);
  if (project.watchPane) await deps.herdr.paneClose(project.watchPane).catch(() => undefined);
  await saveProject(deps.env, { ...project, watchPane: null });
  deps.out(`team stopped${open.length ? `; lanes still open: ${open.map((l) => `${l.id} (${l.branch})`).join(", ")}` : ""}`);
}

export async function resendIntro(deps: Deps, project: Project, state: State, name: string): Promise<void> {
  const seat = state.seats.get(name);
  if (!seat?.live) throw new SlpError(`No live seat "${name}"`);
  const where = seat.lane ? ` (lane ${seat.lane}${seat.task ? `, task ${seat.task}` : ""})` : ` for ${project.root}`;
  await sendLetter(deps, project.id, { letter: "INTRO", from: "slp", to: name, lane: seat.lane, task: seat.task,
    text: intro(name, seat.role, where, seat.agent) });
}

export async function closeLane(a: Actor, laneId: string, how: { land: boolean; drop: boolean; overGate: boolean; reason: string }): Promise<void> {
  const lane = a.state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(`No open lane ${laneId}`);
  if (how.land === how.drop) throw new SlpError("Say how: --land, or --drop --reason \"...\"");
  if (how.drop) return dropLane(a.deps, a.project, laneId, how.reason);
  if (how.overGate && !how.reason.trim()) throw new SlpError("Landing over a red gate needs --reason \"...\"");
  const events = await readLedger(a.deps.env, a.project.id);
  if (pendingRequests(events).some((r) => r.lane === laneId)) throw new SlpError(`Lane ${laneId} has a gate or landing in progress.`);
  const req = await append(a.deps.env, a.project.id, (evs) => ({
    kind: "request" as const, request: nextId(evs, "request", "Q"), what: "land" as const, lane: laneId, by: a.seat.name,
    note: how.reason, overGate: how.overGate,
  }));
  const watching = await lockHeldByLiveProcess(watchLockPath(a.deps.env, a.project.id));
  a.deps.out(`Landing ${laneId} (${req.request}): the watcher merges ${lane.base} in, runs the gate and lands it; a LANDED or REPORT letter follows.` +
    (watching ? "" : " No watcher is running: the Human must start one (`slp watch`)."));
}

export async function setProject(a: Actor, opts: { base?: string | undefined; gate?: string | undefined; noGate: boolean; timeout?: string | undefined }): Promise<void> {
  const s = a.state.settings;
  let timeout = s.gateTimeoutMinutes;
  if (opts.timeout !== undefined) {
    timeout = Number(opts.timeout);
    if (!Number.isInteger(timeout) || timeout < 1) throw new SlpError("--gate-timeout is whole minutes, at least 1");
  }
  if (opts.gate !== undefined && opts.noGate) throw new SlpError("Pass --gate or --no-gate, not both");
  const next = { base: opts.base ?? s.base, gate: opts.noGate ? null : opts.gate ?? s.gate, gateTimeoutMinutes: timeout, landAs: "squash" as const };
  await append(a.deps.env, a.project.id, () => ({ kind: "project" as const, ...next }));
  a.deps.out(`base ${next.base}; gate ${next.gate ?? "none"} (${next.gateTimeoutMinutes} min)`);
}

export function render(project: Project, state: State, now: number, contextFile: string): string {
  const ago = (ts: string) => `${Math.max(0, Math.round((now - Date.parse(ts)) / 60_000))}m`;
  const lines = [`slp ${project.id} · ${project.root}`, `base ${state.settings.base} · gate ${state.settings.gate ?? "none"}`];
  const seats = liveSeats(state);
  lines.push("", `Seats (${seats.length}):`);
  for (const s of seats) {
    lines.push(`  ${s.name.padEnd(8)} ${s.role.padEnd(10)} ${s.launcher}${s.model ? ` ${s.model}` : ""}${s.effort ? ` ${s.effort}` : ""} · pane ${s.paneId}`);
  }
  const lanes = [...state.lanes.values()].filter((l) => l.open);
  lines.push("", `Open lanes (${lanes.length}):`);
  for (const l of lanes) {
    lines.push(`  ${l.id} ${l.title} · ${l.branch}${l.inCheckout ? " (your checkout)" : ` @ ${l.workdir}`}`);
    for (const t of [...state.tasks.values()].filter((x) => x.lane === l.id)) {
      lines.push(`    ${t.id} ${t.state}${t.reworks ? ` (rework ${t.reworks})` : ""}${t.mode === "parallel" ? " parallel" : ""}: ${t.title}`);
    }
    const gate = state.gates.filter((g) => g.lane === l.id).at(-1);
    if (gate) lines.push(`    gate ${gate.ok ? "green" : "RED"} ${ago(gate.ts)} ago`);
  }
  const asks = [...state.asks.values()].filter((a) => a.answer === null);
  if (asks.length) {
    lines.push("", "Open asks:");
    for (const a of asks) lines.push(`  ${a.id} ${a.from} → ${a.to} (${ago(a.askedAt)}): ${a.text.slice(0, 100)}`);
  }
  const waiting = state.letters.filter((l) => l.status !== "delivered");
  if (waiting.length) {
    lines.push("", "Letters not confirmed delivered:");
    for (const l of waiting.slice(-10)) lines.push(`  #${l.seq} ${l.letter} ${l.from} → ${l.to}: ${l.status}${l.error ? ` (${l.error})` : ""}`);
  }
  const landed = [...state.lanes.values()].filter((l) => l.landed).slice(-5);
  if (landed.length) {
    lines.push("", "Landed:");
    for (const l of landed) lines.push(`  ${l.id} ${l.title} → ${l.commit?.slice(0, 10)}`);
  }
  lines.push("", `concept: ${contextFile}`);
  return lines.join("\n");
}
