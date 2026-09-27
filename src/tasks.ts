import { join } from "node:path";
import type { Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import { contextPath, type Project } from "./core/project.js";
import { addWorktree, changedFiles, commonDir, dirtyPaths, git, head, mergeInto, removeWorktree } from "./git.js";
import { matches, overlaps } from "./globs.js";
import { intro } from "./guide.js";
import { sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { fold, type Lane, type Seat, type State, type Task } from "./state.js";

// Tasks and reviews inside a lane (ADR 0008). The Lead briefs, Peers build and
// hand back, the Lead judges. One writer per working copy: lane-mode tasks
// share the lane's copy one at a time; a parallel task gets its own worktree.

/** The seat running a verb, with its project and current state. */
export interface Actor { deps: Deps; project: Project; state: State; seat: Seat }

const ACTIVE = new Set(["running", "handed-back", "rework"]);

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
}

export function laneOf(a: Actor): Lane {
  const lane = a.seat.lane ? a.state.lanes.get(a.seat.lane) : undefined;
  if (!lane || !lane.open) throw new SlpError(`${a.seat.name} has no open lane.`);
  return lane;
}

function taskOfLead(a: Actor, id: string): Task {
  const lane = laneOf(a);
  const task = a.state.tasks.get(id);
  if (!task || task.lane !== lane.id) throw new SlpError(`No task ${id} in lane ${lane.id}`);
  return task;
}

export interface TaskInput {
  title: string;
  goal: string;
  acceptance: string[];
  owned: string[];
  outOfScope: string[];
  context: string;
  preset: string | null;
  parallel: boolean;
}

function brief(t: Pick<Task, "id" | "title" | "goal" | "acceptance" | "owned" | "outOfScope" | "context" | "branch" | "workdir">,
  lane: Lane, context: string): string {
  return [
    `Task ${t.id}: ${t.title}`, "", `Goal: ${t.goal}`, "", "Acceptance:", ...t.acceptance.map((x) => `- ${x}`), "",
    `You own (change only these): ${t.owned.join(", ")}`,
    ...(t.outOfScope.length ? ["Out of scope:", ...t.outOfScope.map((x) => `- ${x}`)] : []),
    ...(t.context.trim() ? ["", "Context:", t.context] : []),
    "", `Working copy: ${t.workdir}`, `Branch: ${t.branch} (commit here; never push, switch branches or merge)`,
    "", `Lane ${lane.id} outcome, for context: ${lane.outcome}`, `The Human's concept (read-only): ${context}`,
  ].join("\n");
}

export async function startTask(a: Actor, config: Config, input: TaskInput): Promise<Task> {
  const { deps, project } = a;
  const lane = laneOf(a);
  if (!input.title.trim() || !input.goal.trim()) throw new SlpError("A task needs --title and --goal.");
  if (!input.acceptance.length) throw new SlpError("A task needs acceptance: --accept \"...\" (repeatable).");
  if (!input.owned.length) throw new SlpError("A task needs owned paths: --own \"src/area/**\" (repeatable).");
  const outside = input.owned.filter((o) => !overlaps([o], lane.writeSet));
  if (outside.length) {
    throw new SlpError(`Owned paths outside lane ${lane.id}'s write set (${lane.writeSet.join(", ")}): ${outside.join(", ")}. ` +
      "Ask the Supervisor to amend the lane if the task really needs them.");
  }
  const active = [...a.state.tasks.values()].filter((t) => t.lane === lane.id && ACTIVE.has(t.state));
  const clash = active.find((t) => overlaps(input.owned, t.owned));
  if (clash) throw new SlpError(`Owned paths overlap ${clash.id} (${clash.owned.join(", ")}), still ${clash.state}.`);
  const holder = active.find((t) => t.mode === "lane");
  if (!input.parallel && holder) {
    throw new SlpError(`${holder.id} holds the lane's working copy until it is accepted or cut. ` +
      "Wait, or start this task with --parallel (its own copy).");
  }

  const number = [...a.state.tasks.values()].filter((t) => t.lane === lane.id).length + 1;
  const id = `${lane.id}-T${number}`;
  let branch = lane.branch;
  let workdir = lane.workdir;
  const laneHead = await head(lane.workdir);
  if (input.parallel) {
    branch = `task/${id}-${slug(input.title)}`;
    workdir = join(projectDir(deps.env, project.id), "slots", id);
    await addWorktree(project.root, workdir, branch, laneHead);
  }
  const draft = { id, title: input.title, goal: input.goal, acceptance: input.acceptance, owned: input.owned,
    outOfScope: input.outOfScope, context: input.context, branch, workdir };
  try {
    const opened = await openSeat(deps, project, config, {
      name: id, role: "peer", lane: lane.id, task: id, cwd: workdir, preset: input.preset,
      place: { kind: "split", from: a.seat.paneId, direction: "right" },
      writableDirs: [await commonDir(project.root)],
      intro: intro(id, "peer", ` (lane ${lane.id}, task ${id})`, "codex"),
    });
    if (opened.attention) deps.out(`NEEDS ATTENTION: ${opened.attention}`);
  } catch (error) {
    if (input.parallel) {
      await removeWorktree(project.root, workdir);
      await git(project.root, ["branch", "-D", branch]);
    }
    throw error;
  }
  await append(deps.env, project.id, () => ({
    kind: "task-start" as const, lane: lane.id, task: id, title: input.title, goal: input.goal, acceptance: input.acceptance,
    owned: input.owned, outOfScope: input.outOfScope, context: input.context, mode: input.parallel ? "parallel" as const : "lane" as const,
    branch, workdir, baseCommit: laneHead, seat: id,
  }));
  await sendLetter(deps, project.id, { letter: "TASK", from: a.seat.name, to: id, lane: lane.id, task: id,
    text: brief(draft, lane, contextPath(deps.env, project.id)) });
  return fold(await readLedger(deps.env, project.id)).tasks.get(id)!;
}

export interface Handback { outcome: "complete" | "partial" | "blocked"; summary: string; checks: string[]; left: string }

/** A Peer hands its task back to the Lead. */
export async function handBack(a: Actor, h: Handback): Promise<void> {
  const { deps, project } = a;
  const task = a.seat.task ? a.state.tasks.get(a.seat.task) : undefined;
  if (!task) throw new SlpError(`${a.seat.name} has no task.`);
  if (task.state !== "running" && task.state !== "rework") {
    throw new SlpError(`Task ${task.id} is ${task.state}; wait for the Lead's letter.`);
  }
  if (!h.summary.trim()) throw new SlpError("Say what you did: pass the summary as text or on stdin (-).");
  if (h.outcome === "complete" && !h.checks.length) {
    throw new SlpError("A complete hand-back needs evidence: --check \"command: result\" (repeatable).");
  }
  const dirty = await dirtyPaths(task.workdir);
  if (dirty.length && h.outcome !== "blocked") {
    throw new SlpError(`Commit your work first; uncommitted in ${task.workdir}: ${dirty.slice(0, 10).join(", ")}`);
  }
  const tip = await head(task.workdir);
  const changed = await changedFiles(task.workdir, task.baseCommit, tip);
  const outside = changed.filter((f) => !matches(task.owned, f));
  const log = (await git(task.workdir, ["log", "--oneline", `${task.baseCommit}..${tip}`])).stdout.trim();
  await append(deps.env, project.id, () => ({
    kind: "task-done" as const, task: task.id, outcome: h.outcome, summary: h.summary, checks: h.checks, leftUndone: h.left, head: tip,
  }));
  const text = [
    `Outcome: ${h.outcome}`, "", h.summary.trim(), "",
    "Checks:", ...(h.checks.length ? h.checks.map((c) => `- ${c}`) : ["- none"]),
    ...(h.left.trim() ? ["", `Left undone: ${h.left}`] : []),
    "", `Commits (${task.branch}):`, log || "(none)",
    `Changed: ${changed.join(", ") || "(nothing)"}`,
    ...(outside.length ? [`OUTSIDE owned paths (${task.owned.join(", ")}): ${outside.join(", ")}`] : []),
    ...(dirty.length ? [`Uncommitted: ${dirty.join(", ")}`] : []),
    "", `Diff: git -C "${task.workdir}" diff ${task.baseCommit.slice(0, 10)}..${tip.slice(0, 10)}`,
  ].join("\n");
  await sendLetter(deps, project.id, { letter: "HANDBACK", from: a.seat.name, to: task.lane, lane: task.lane, task: task.id, text });
}

async function finishSeat(a: Actor, task: Task, reason: string): Promise<void> {
  const seat = a.state.seats.get(task.seat);
  if (seat?.live) await closeSeat(a.deps, a.project.id, seat, reason);
}

export async function acceptTask(a: Actor, id: string, note: string): Promise<void> {
  const { deps, project } = a;
  const task = taskOfLead(a, id);
  const lane = laneOf(a);
  if (task.state !== "handed-back") throw new SlpError(`Task ${id} is ${task.state}; only a handed-back task can be accepted.`);
  let merged: string | null = null;
  if (task.mode === "lane") {
    const dirty = await dirtyPaths(task.workdir);
    if (dirty.length) throw new SlpError(`The lane's working copy has uncommitted changes (${dirty.slice(0, 10).join(", ")}); rework ${id} to commit or discard them.`);
  } else {
    const writer = [...a.state.tasks.values()].find((t) => t.lane === lane.id && t.mode === "lane" && (t.state === "running" || t.state === "rework"));
    if (writer) throw new SlpError(`${writer.id} is writing in the lane's working copy; accept ${id} once it hands back.`);
    for (const dir of [task.workdir, lane.workdir]) {
      const dirty = await dirtyPaths(dir);
      if (dirty.length) throw new SlpError(`Uncommitted changes in ${dir} (${dirty.slice(0, 10).join(", ")}); they must be committed or discarded first.`);
    }
    const result = await mergeInto(lane.workdir, task.branch, `Merge ${id}: ${task.title}`);
    if (!result.ok) {
      throw new SlpError(`${task.branch} conflicts with ${lane.branch} in: ${result.conflicts.join(", ")}. ` +
        `Nothing was merged. Cut ${id} and redo it on the lane's copy, or rework it narrower.`);
    }
    merged = await head(lane.workdir);
  }
  await append(deps.env, project.id, () => ({ kind: "task-accept" as const, task: id, note, merged }));
  await finishSeat(a, task, `task ${id} accepted`);
  if (task.mode === "parallel") {
    await removeWorktree(project.root, task.workdir);
    await git(project.root, ["branch", "-D", task.branch]);
  }
  deps.out(`${id} accepted${merged ? ` and merged into ${lane.branch}` : ""}`);
}

export async function reworkTask(a: Actor, id: string, text: string): Promise<void> {
  const task = taskOfLead(a, id);
  if (task.state !== "handed-back") throw new SlpError(`Task ${id} is ${task.state}; only a handed-back task can be sent back.`);
  if (!text.trim()) throw new SlpError("Say what to change and why.");
  if (!a.state.seats.get(task.seat)?.live) throw new SlpError(`${task.seat} is closed; cut ${id} and start a new task.`);
  await append(a.deps.env, a.project.id, () => ({ kind: "task-rework" as const, task: id, note: text }));
  await sendLetter(a.deps, a.project.id, { letter: "REWORK", from: a.seat.name, to: task.seat, lane: task.lane, task: id, text });
}

export async function cutTask(a: Actor, id: string, reason: string): Promise<void> {
  const task = taskOfLead(a, id);
  if (!ACTIVE.has(task.state)) throw new SlpError(`Task ${id} is already ${task.state}.`);
  if (!reason.trim()) throw new SlpError("Say why the task is cut.");
  await append(a.deps.env, a.project.id, () => ({ kind: "task-cut" as const, task: id, reason }));
  await finishSeat(a, task, `task ${id} cut`);
  if (task.mode === "parallel") {
    await removeWorktree(a.project.root, task.workdir);
    a.deps.out(`${id} cut; its branch ${task.branch} is kept`);
    return;
  }
  const dirty = await dirtyPaths(task.workdir);
  a.deps.out(`${id} cut. Its commits stay on ${task.branch}` +
    (dirty.length ? `; uncommitted changes remain in the lane's copy (${dirty.slice(0, 10).join(", ")})` : "") +
    ". Undo them with a new task if they are unwanted.");
}

export async function startReview(a: Actor, config: Config, target: { task: string | null; lane: boolean }, focus: string): Promise<void> {
  const { deps, project } = a;
  const lane = laneOf(a);
  if ((target.task === null) === !target.lane) throw new SlpError("Review one thing: --task L1-T2 or --lane.");
  let range: string;
  let cwd = lane.workdir;
  let what: string;
  let acceptance: string[];
  if (target.task) {
    const task = taskOfLead(a, target.task);
    if (task.state !== "handed-back") throw new SlpError(`Task ${task.id} is ${task.state}; review a handed-back task.`);
    range = `${task.baseCommit}..${task.lastDone?.head ?? task.branch}`;
    if (task.mode === "parallel") cwd = task.workdir;
    what = `task ${task.id}: ${task.title}\nGoal: ${task.goal}`;
    acceptance = task.acceptance;
  } else {
    range = `${lane.baseCommit}..${lane.branch}`;
    what = `lane ${lane.id}: ${lane.title}\nOutcome: ${lane.outcome}`;
    acceptance = lane.acceptance;
  }
  const number = [...a.state.reviews.values()].filter((r) => r.lane === lane.id).length + 1;
  const id = `${lane.id}-R${number}`;
  const opened = await openSeat(deps, project, config, {
    name: id, role: "reviewer", lane: lane.id, task: target.task, cwd,
    place: { kind: "split", from: a.seat.paneId, direction: "down" },
    intro: intro(id, "reviewer", ` (lane ${lane.id})`, "claude"),
  });
  if (opened.attention) deps.out(`NEEDS ATTENTION: ${opened.attention}`);
  await append(deps.env, project.id, () => ({
    kind: "review-start" as const, lane: lane.id, review: id, target: target.task ?? lane.id, focus, seat: id,
  }));
  await sendLetter(deps, project.id, { letter: "REVIEW", from: a.seat.name, to: id, lane: lane.id, task: target.task, text: [
    `Review ${what}`, "", "Acceptance:", ...acceptance.map((x) => `- ${x}`), "",
    `The change: git -C "${cwd}" diff ${range}`, `Working copy: ${cwd} (read only)`,
    ...(focus.trim() ? ["", `Focus: ${focus}`] : []),
  ].join("\n") });
}

export interface Finding { severity: "high" | "medium" | "low"; where: string; what: string; evidence: string }

export function parseFinding(raw: string): Finding {
  const parts = raw.split("::").map((p) => p.trim());
  const severity = parts[0]?.toLowerCase();
  if (parts.length !== 4 || (severity !== "high" && severity !== "medium" && severity !== "low") || parts.some((p) => !p)) {
    throw new SlpError(`A finding is "high|medium|low :: where :: what :: evidence", got: ${raw}`);
  }
  return { severity, where: parts[1]!, what: parts[2]!, evidence: parts[3]! };
}

/** A Reviewer reports. */
export async function finishReview(a: Actor, summary: string, findings: Finding[]): Promise<void> {
  const review = [...a.state.reviews.values()].find((r) => r.seat === a.seat.name && !r.done);
  if (!review) throw new SlpError(`${a.seat.name} has no open review.`);
  if (!summary.trim()) throw new SlpError("Say what you checked and how: pass it as text or on stdin (-).");
  await append(a.deps.env, a.project.id, () => ({ kind: "review-done" as const, review: review.id, summary, findings }));
  const text = [
    summary.trim(), "",
    findings.length ? `Findings (${findings.length}):` : "No findings.",
    ...findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.what}\n   evidence: ${f.evidence}`),
  ].join("\n");
  await sendLetter(a.deps, a.project.id, { letter: "FINDINGS", from: a.seat.name, to: review.lane, lane: review.lane,
    task: a.seat.task, text });
  // The watcher closes this seat once its turn ends (closing it here would
  // kill the agent in the middle of this command).
  a.deps.out("Review recorded and sent. You are done; this seat closes shortly.");
}
