import { stat, writeFile } from "node:fs/promises";
import type { Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger, type EventOf } from "./core/ledger.js";
import { lockHeldByLiveProcess } from "./core/lock.js";
import { contextPath, ensureProject, saveProject, type Project } from "./core/project.js";
import { detectGate } from "./gate.js";
import { commonDir, git, head, toplevel } from "./git.js";
import { intro } from "./guide.js";
import { pendingRequests } from "./land.js";
import { dropLane } from "./lanes.js";
import { sendLetter, watchLockPath } from "./letters.js";
import { closeSeat, detectShell, moveSeat, openSeat } from "./seats.js";
import { codexHomes } from "./watch/observer.js";
import { codexSessionId, findCodexRollout, humanWordsSince } from "./watch/transcripts.js";
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

/**
 * Skill files (and the agent guidance) the repository has not committed: a
 * lane in its own worktree only sees committed files.
 */
export async function uncommittedSkills(root: string): Promise<string[]> {
  const r = await git(root, ["status", "--porcelain", "--untracked-files=all", "--", ".claude/skills", ".agents/skills", "AGENTS.md", "CLAUDE.md"]);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter((l) => l.length > 3).map((l) => l.slice(3).trim()) : [];
}

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
  const loose = await uncommittedSkills(project.root);
  if (loose.length) {
    deps.out(`note: ${loose.length} skill or guidance file(s) are not committed (${loose.slice(0, 3).join(", ")}${loose.length > 3 ? ", ..." : ""}); ` +
      "lanes in their own worktree will not see them. Commit them to share them with every lane.");
  }
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

/** Send a seat its first letter (introduction and brief) again, e.g. after the Human answered a startup dialog. */
export async function resendIntro(deps: Deps, project: Project, state: State, name: string): Promise<void> {
  const seat = state.seats.get(name);
  if (!seat?.live) throw new SlpError(`No live seat "${name}"`);
  const events = await readLedger(deps.env, project.id);
  const opened = events.findLast((e) => e.kind === "seat" && e.name === name)?.seq ?? 0;
  const first = events.find((e) => e.kind === "letter" && e.to === name && e.seq > opened);
  if (first?.kind === "letter") {
    await sendLetter(deps, project.id, { letter: first.letter, from: first.from, to: name, lane: first.lane, task: first.task, text: first.text });
    return;
  }
  const where = seat.lane ? ` (lane ${seat.lane}${seat.task ? `, task ${seat.task}` : ""})` : ` for ${project.root}`;
  await sendLetter(deps, project.id, { letter: "INTRO", from: "slp", to: name, lane: seat.lane, task: seat.task,
    text: intro(name, seat.role, where, seat.agent) });
}

export async function closeLane(a: Actor, laneId: string, how: { land: boolean; drop: boolean; overGate: boolean; overRisk?: boolean; reason: string }): Promise<void> {
  if (a.state.queued.has(laneId) && how.drop) return dropLane(a.deps, a.project, laneId, how.reason);
  const lane = a.state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(a.state.queued.has(laneId) ? `Lane ${laneId} is queued; it can only be dropped until it opens.` : `No open lane ${laneId}`);
  if (how.land === how.drop) throw new SlpError("Say how: --land, or --drop --reason \"...\"");
  if (how.drop) return dropLane(a.deps, a.project, laneId, how.reason);
  if ((how.overGate || how.overRisk) && !how.reason.trim()) throw new SlpError("Landing over a red gate or a risk hold needs --reason \"...\" (the Human's words).");
  const events = await readLedger(a.deps.env, a.project.id);
  if (pendingRequests(events).some((r) => r.lane === laneId)) throw new SlpError(`Lane ${laneId} has a gate or landing in progress.`);
  let note = how.reason;
  let approved: string | undefined;
  if (how.overRisk) {
    // Lifting a hold is the Human's call (ADR 0015): it needs a hold, and the
    // Human's own words to the Supervisor since then, which go on the record.
    const held = events.findLast((e): e is EventOf<"request-done"> => e.kind === "request-done" && e.detail.startsWith("held for the Human") &&
      events.some((r) => r.kind === "request" && r.request === e.request && r.lane === laneId));
    if (!held) throw new SlpError(`${laneId} has not been held. Land it without --over-risk; slp says if it holds it for the Human.`);
    // The override covers the work that was held, not work added since.
    const heldAt = /\[at ([0-9a-f]{40})\]/.exec(held.detail)?.[1];
    if (!heldAt || heldAt !== await head(a.project.root, lane.branch)) {
      throw new SlpError(`${laneId} changed since it was held; land it without --over-risk so slp checks the new work, and show the Human any new hold.`);
    }
    const sup = a.state.seats.get("sup");
    const words = sup?.sessionId ? await humanWordsSince(a.deps.env, sup.sessionId, held.ts).catch(() => []) : [];
    if (!words.length) {
      throw new SlpError(`slp found no words from the Human since ${laneId} was held (${held.ts}). Show them the reason; land over the hold only once they agree here.`);
    }
    approved = heldAt;
    note = `${how.reason}\n\nThe Human, after the hold:\n${words.map((w) => `> ${w.replace(/\n/g, "\n> ")}`).join("\n")}`;
  }
  const req = await append(a.deps.env, a.project.id, (evs) => ({
    kind: "request" as const, request: nextId(evs, "request", "Q"), what: "land" as const, lane: laneId, by: a.seat.name,
    note, overGate: how.overGate, ...(how.overRisk ? { overRisk: true, heldAt: approved } : {}),
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
    lines.push(`  ${l.id} ${l.title} · ${l.branch}${l.home === "onBranch" ? " (your branch, your checkout)" : l.inCheckout ? " (your checkout)" : ` @ ${l.workdir}`}`);
    for (const t of [...state.tasks.values()].filter((x) => x.lane === l.id)) {
      lines.push(`    ${t.id} ${t.state}${t.reworks ? ` (rework ${t.reworks})` : ""}${t.mode === "parallel" ? " parallel" : ""}: ${t.title}`);
    }
    const gate = state.gates.filter((g) => g.lane === l.id).at(-1);
    if (gate) lines.push(`    gate ${gate.ok ? "green" : "RED"} ${ago(gate.ts)} ago`);
  }
  if (state.queued.size) {
    lines.push("", "Queued lanes:");
    for (const q of state.queued.values()) lines.push(`  ${q.lane} ${q.input.title} · opens in your checkout after ${q.after}`);
  }
  if (state.keptSlots.size) {
    lines.push("", "Kept working copies (remove with `slp clean` once safe; `slp clean --force` discards their changes):");
    for (const k of state.keptSlots.values()) lines.push(`  ${k.path} (${k.owner}, ${ago(k.since)} ago): ${k.why}`);
  }
  if (state.freeSlots.size) {
    lines.push("", `Copies kept for reuse (${state.freeSlots.size}; \`slp clean\` removes them):`);
    for (const p of state.freeSlots) lines.push(`  ${p}`);
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

/** The Human's own word to a seat: recorded, delivered, and copied to the Supervisor. */
export async function humanTells(deps: Deps, project: Project, state: State, name: string, body: string): Promise<void> {
  const seat = state.seats.get(name);
  if (!seat?.live) throw new SlpError(`No live seat "${name}" (\`slp status\` lists them).`);
  if (!body.trim()) throw new SlpError('Say something: slp tell <seat> "..."');
  await sendLetter(deps, project.id, { letter: "MESSAGE", from: "human", to: name, lane: seat.lane, task: seat.task, text: body });
  const copy = name !== "sup" && state.seats.get("sup")?.live === true;
  if (copy) {
    await sendLetter(deps, project.id, { letter: "NOTICE", from: "slp", to: "sup", lane: seat.lane, task: seat.task,
      text: `The Human told ${name} directly (for your record; nothing to do unless it changes the plan):\n${body}` });
  }
  deps.out(`told ${name}${copy ? "; the Supervisor has a copy" : ""}`);
}

/** The Supervisor moves a seat whose account ran out to another (ADR 0011). */
export async function moveSeatVerb(a: Actor, config: Config, name: string, launcher: string): Promise<void> {
  const seat = a.state.seats.get(name);
  if (!seat?.live) throw new SlpError(`No live seat "${name}"`);
  if (seat.name === "sup") throw new SlpError("The Supervisor's own seat moves only by the Human (restart it on another account).");
  const status = await a.deps.herdr.agentStatus(seat.paneId).catch(() => null);
  if (status === "working") throw new SlpError(`${name} is working; move it when its turn has ended.`);
  let resume: string | null = seat.sessionId;
  if (seat.agent === "codex" && seat.marker) {
    const path = await findCodexRollout(codexHomes(config, a.deps.env, seat.launcher), seat.marker, new Date(seat.openedAt));
    resume = path ? await codexSessionId(path) : null;
  }
  if (!resume) throw new SlpError(`No session of ${name} was found to resume; cut its task and start a new one instead.`);
  const task = seat.task ? a.state.tasks.get(seat.task) : undefined;
  const lane = seat.lane ? a.state.lanes.get(seat.lane) : undefined;
  const cwd = task?.workdir ?? lane?.workdir ?? a.project.root;
  const writableDirs = seat.role === "peer" ? [await commonDir(a.project.root)] : [];
  const moved = await moveSeat(a.deps, a.project, config, seat, { launcher, cwd, resume, writableDirs });
  if (moved.attention) a.deps.out(`NEEDS ATTENTION: ${moved.attention}`);
}
