import { join } from "node:path";
import type { Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import type { Project } from "./core/project.js";
import { addWorktree, currentBranch, dirtyPaths, git, gitOk, head, removeWorktree } from "./git.js";
import { isCatchAll, overlaps } from "./globs.js";
import { intro } from "./guide.js";
import { describe, sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { fold, liveSeats, type Lane, type State } from "./state.js";

export interface LaneInput {
  title: string;
  outcome: string;
  acceptance: string[];
  outOfScope: string[];
  writeSet: string[];
  humanWords: string;
  isolate: boolean;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/^-+|-+$/g, "") || "lane";
}

export function checkWriteSet(state: State, writeSet: readonly string[], except?: string): void {
  if (!writeSet.length) throw new SlpError("A lane needs a write set: --write \"src/area/**\" (repeatable).");
  const wide = writeSet.filter(isCatchAll);
  if (wide.length) throw new SlpError(`Write set too wide (${wide.join(", ")}): name the areas this outcome changes.`);
  for (const lane of state.lanes.values()) {
    if (!lane.open || lane.id === except) continue;
    if (overlaps(writeSet, lane.writeSet)) {
      throw new SlpError(`Write set overlaps open lane ${lane.id} (${lane.writeSet.join(", ")}). ` +
        `Amend ${lane.id} instead, or wait for it to close.`);
    }
  }
}

function directive(lane: Lane): string {
  return [
    `Lane ${lane.id}: ${lane.title}`,
    "",
    `Outcome: ${lane.outcome}`,
    "",
    "Acceptance:",
    ...lane.acceptance.map((a) => `- ${a}`),
    ...(lane.outOfScope.length ? ["", "Out of scope:", ...lane.outOfScope.map((o) => `- ${o}`)] : []),
    "",
    `Write set: ${lane.writeSet.join(", ")}`,
    `Branch: ${lane.branch}   Working copy: ${lane.workdir}   Base: ${lane.base} @ ${lane.baseCommit.slice(0, 10)}`,
    "The Human's concept (read-only for you): `slp context`",
    ...(lane.humanWords ? ["", "The Human asked:", lane.humanWords] : []),
  ].join("\n");
}

export async function openLane(deps: Deps, project: Project, config: Config, input: LaneInput): Promise<Lane> {
  if (!input.title.trim() || !input.outcome.trim()) throw new SlpError("A lane needs --title and --outcome.");
  if (!input.acceptance.length) throw new SlpError("A lane needs acceptance: --accept \"...\" (repeatable).");
  const events = await readLedger(deps.env, project.id);
  const state = fold(events);
  checkWriteSet(state, input.writeSet);
  const id = nextId(events, "lane-open", "L");
  const branch = `lane/${id}-${slug(input.title)}`;
  const base = state.settings.base;
  const baseCommit = await head(project.root, base);

  // The first lane works in the Human's checkout; later or isolated lanes get
  // a worktree of their own (ADR 0008).
  const checkoutBusy = [...state.lanes.values()].some((l) => l.open && l.inCheckout);
  const onBase = (await currentBranch(project.root)) === base;
  const clean = (await dirtyPaths(project.root)).length === 0;
  const inCheckout = !input.isolate && !checkoutBusy && onBase && clean;
  let workdir = project.root;
  if (inCheckout) {
    await gitOk(project.root, ["checkout", "-b", branch, base]);
  } else {
    workdir = join(projectDir(deps.env, project.id), "slots", id);
    await addWorktree(project.root, workdir, branch, base);
  }
  await append(deps.env, project.id, () => ({
    kind: "lane-open" as const, lane: id, title: input.title, outcome: input.outcome, acceptance: input.acceptance,
    outOfScope: input.outOfScope, writeSet: input.writeSet, branch, workdir, inCheckout, base, baseCommit,
    humanWords: input.humanWords,
  }));
  const lane = fold(await readLedger(deps.env, project.id)).lanes.get(id)!;
  deps.out(`lane ${id} opened on ${branch} (${inCheckout ? "your checkout" : workdir})`);

  const lead = await openSeat(deps, project, config, {
    name: id, role: "lead", lane: id, task: null, cwd: workdir, place: { kind: "tab", label: `${id} ${input.title}`.slice(0, 40) },
    intro: intro(id, "lead", ` (lane ${id}: ${input.title})`, config.launchers[config.roles.lead.use[0]!]?.agent ?? "claude"),
    brief: { letter: "DIRECTIVE", from: "sup", text: directive(lane) },
  });
  if (lead.attention) deps.out(`NEEDS ATTENTION: ${lead.attention}`);

  if (input.humanWords.trim()) await openCritic(deps, project, config, lane, lead.seat.paneId);
  return lane;
}

/** A Critic reads the lane against the Human's words once (ADR 0007); the lane runs without one if it cannot open. */
async function openCritic(deps: Deps, project: Project, config: Config, lane: Lane, beside: string): Promise<void> {
  const name = `${lane.id}-critic`;
  try {
    const critic = await openSeat(deps, project, config, {
      name, role: "critic", lane: lane.id, task: null, cwd: lane.workdir,
      place: { kind: "split", from: beside, direction: "down" },
      intro: intro(name, "critic", ` (lane ${lane.id})`, config.launchers[config.roles.critic.use[0]!]?.agent ?? "claude"),
      brief: {
        letter: "MESSAGE", from: "slp",
        text: [
          "Read this lane against the Human's own words and the concept (`slp context`), then report with `slp findings`.",
          "", "The Human's words:", lane.humanWords, "", "The lane:", directive(lane),
        ].join("\n"),
      },
    });
    if (critic.attention) deps.out(`NEEDS ATTENTION: ${critic.attention}`);
  } catch (error) {
    deps.out(`The Critic for ${lane.id} could not open (${describe(error)}); the lane runs without it.`);
  }
}

export interface Amendment { why: string; outcome?: string; acceptance?: string[]; outOfScope?: string[]; writeSet?: string[] }

export async function amendLane(deps: Deps, project: Project, laneId: string, a: Amendment): Promise<void> {
  const state = fold(await readLedger(deps.env, project.id));
  const lane = state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(`No open lane ${laneId}`);
  if (!a.why.trim()) throw new SlpError("Say why: --why \"...\"");
  if (a.writeSet) checkWriteSet(state, a.writeSet, laneId);
  await append(deps.env, project.id, () => ({
    kind: "lane-amend" as const, lane: laneId, why: a.why,
    ...(a.outcome !== undefined ? { outcome: a.outcome } : {}),
    ...(a.acceptance !== undefined ? { acceptance: a.acceptance } : {}),
    ...(a.outOfScope !== undefined ? { outOfScope: a.outOfScope } : {}),
    ...(a.writeSet !== undefined ? { writeSet: a.writeSet } : {}),
  }));
  const changed = [a.outcome !== undefined && `outcome: ${a.outcome}`, a.acceptance && `acceptance: ${a.acceptance.join(" | ")}`,
    a.outOfScope && `out of scope: ${a.outOfScope.join(" | ")}`, a.writeSet && `write set: ${a.writeSet.join(", ")}`].filter(Boolean);
  await sendLetter(deps, project.id, { letter: "MESSAGE", from: "sup", to: laneId, lane: laneId,
    text: `Lane ${laneId} amended (${a.why}).\n${changed.join("\n")}` });
}

/** Close a lane's seats (and its tab), and put the Human's checkout back on base. */
export async function teardownLane(deps: Deps, project: Project, lane: Lane, state: State): Promise<void> {
  for (const seat of liveSeats(state).filter((s) => s.lane === lane.id)) await closeSeat(deps, project.id, seat, `lane ${lane.id} closed`);
  const tab = state.seats.get(lane.id)?.tabId;
  if (tab && tab !== project.mainTabId) await deps.herdr.tabClose(tab).catch(() => undefined);
  for (const task of state.tasks.values()) {
    if (task.lane === lane.id && task.mode === "parallel") await removeWorktree(project.root, task.workdir);
  }
  if (lane.inCheckout) {
    const r = await git(project.root, ["checkout", lane.base]);
    if (r.code !== 0) deps.out(`Could not switch your checkout back to ${lane.base}: ${r.stderr.trim()}`);
  } else {
    await removeWorktree(project.root, lane.workdir);
  }
}

/** Drop a lane without landing: seats closed, its branch kept for the record. */
export async function dropLane(deps: Deps, project: Project, laneId: string, reason: string): Promise<void> {
  const state = fold(await readLedger(deps.env, project.id));
  const lane = state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(`No open lane ${laneId}`);
  if (!reason.trim()) throw new SlpError("Say why: --reason \"...\"");
  if (lane.inCheckout && (await dirtyPaths(project.root)).length) {
    throw new SlpError(`Lane ${laneId} has uncommitted changes in the checkout; a Peer must commit or discard them first.`);
  }
  await teardownLane(deps, project, lane, state);
  await append(deps.env, project.id, () => ({ kind: "lane-close" as const, lane: laneId, landed: false, reason, commit: null, overGate: false }));
  deps.out(`lane ${laneId} dropped; branch ${lane.branch} kept`);
}
