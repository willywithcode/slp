import { join } from "node:path";
import { SlpError } from "./core/errors.js";
import { append, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import { addWorktree, changedFiles, commonDir, dirtyPaths, git, head, mergeInto, removeWorktree } from "./git.js";
import { detectGate, runGate } from "./gate.js";
import { matches, overlaps } from "./globs.js";
import { changedLines } from "./risk.js";
import { intro } from "./guide.js";
import { describe, sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { fold } from "./state.js";
const ACTIVE = new Set(["running", "handed-back", "rework"]);
/** A hand-back changing at least this many lines suggests a review. */
export const REVIEW_LINES = 300;
function slug(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24).replace(/^-+|-+$/g, "") || "task";
}
export function laneOf(a) {
    const lane = a.seat.lane ? a.state.lanes.get(a.seat.lane) : undefined;
    if (!lane || !lane.open)
        throw new SlpError(`${a.seat.name} has no open lane.`);
    return lane;
}
function taskOfLead(a, id) {
    const lane = laneOf(a);
    const task = a.state.tasks.get(id);
    if (!task || task.lane !== lane.id)
        throw new SlpError(`No task ${id} in lane ${lane.id}`);
    return task;
}
function brief(t, lane) {
    return [
        `Task ${t.id}: ${t.title}`, "", `Goal: ${t.goal}`, "", "Acceptance:", ...t.acceptance.map((x) => `- ${x}`), "",
        `You own (change only these): ${t.owned.join(", ")}`,
        ...(t.outOfScope.length ? ["Out of scope:", ...t.outOfScope.map((x) => `- ${x}`)] : []),
        ...(t.context.trim() ? ["", "Context:", t.context] : []),
        "", `Working copy: ${t.workdir}`, `Branch: ${t.branch} (commit here; never push, switch branches or merge)`,
        "", `Lane ${lane.id} outcome, for context: ${lane.outcome}`, "The Human's concept: `slp context`",
    ].join("\n");
}
export async function startTask(a, config, input) {
    const { deps, project } = a;
    const lane = laneOf(a);
    if (!input.title.trim() || !input.goal.trim())
        throw new SlpError("A task needs --title and --goal.");
    if (!input.acceptance.length)
        throw new SlpError("A task needs acceptance: --accept \"...\" (repeatable).");
    if (!input.owned.length)
        throw new SlpError("A task needs owned paths: --own \"src/area/**\" (repeatable).");
    const outside = input.owned.filter((o) => !overlaps([o], lane.writeSet));
    if (outside.length) {
        throw new SlpError(`Owned paths outside lane ${lane.id}'s write set (${lane.writeSet.join(", ")}): ${outside.join(", ")}. ` +
            "Ask the Supervisor to amend the lane if the task really needs them.");
    }
    const laneHead = await head(lane.workdir);
    const slots = join(projectDir(deps.env, project.id), "slots");
    // Reserved under the ledger lock: id, overlap and the one-writer rule are
    // checked against the record as it is now (a Lead may run commands in
    // parallel), then the task's copy is made.
    const started = await append(deps.env, project.id, (events) => {
        const tasks = [...fold(events).tasks.values()].filter((t) => t.lane === lane.id);
        const active = tasks.filter((t) => ACTIVE.has(t.state));
        const clash = active.find((t) => overlaps(input.owned, t.owned));
        if (clash)
            throw new SlpError(`Owned paths overlap ${clash.id} (${clash.owned.join(", ")}), still ${clash.state}.`);
        const holder = active.find((t) => t.mode === "lane");
        if (!input.parallel && holder) {
            throw new SlpError(`${holder.id} holds the lane's working copy until it is accepted or cut. ` +
                "Wait, or start this task with --parallel (its own copy).");
        }
        const id = `${lane.id}-T${tasks.length + 1}`;
        return {
            kind: "task-start", lane: lane.id, task: id, title: input.title, goal: input.goal, acceptance: input.acceptance,
            owned: input.owned, outOfScope: input.outOfScope, context: input.context, mode: input.parallel ? "parallel" : "lane",
            branch: input.parallel ? `task/${id}-${slug(input.title)}` : lane.branch,
            workdir: input.parallel ? join(slots, id) : lane.workdir, baseCommit: laneHead, seat: id,
        };
    });
    const { task: id, branch, workdir } = started;
    const draft = { id, title: input.title, goal: input.goal, acceptance: input.acceptance, owned: input.owned,
        outOfScope: input.outOfScope, context: input.context, branch, workdir };
    try {
        if (input.parallel)
            await addWorktree(project.root, workdir, branch, laneHead);
        const opened = await openSeat(deps, project, config, {
            name: id, role: "peer", lane: lane.id, task: id, cwd: workdir, preset: input.preset,
            place: { kind: "split", from: a.seat.paneId, direction: "right" },
            writableDirs: [await commonDir(project.root)],
            intro: intro(id, "peer", ` (lane ${lane.id}, task ${id})`, "codex"),
            brief: { letter: "TASK", from: a.seat.name, text: brief(draft, lane) },
        });
        if (opened.attention)
            deps.out(`NEEDS ATTENTION: ${opened.attention}`);
    }
    catch (error) {
        await append(deps.env, project.id, () => ({ kind: "task-cut", task: id, reason: `it could not start: ${describe(error)}` }));
        if (input.parallel && await removeWorktree(project.root, workdir))
            await git(project.root, ["branch", "-D", branch]);
        throw error;
    }
    return fold(await readLedger(deps.env, project.id)).tasks.get(id);
}
/** A Peer hands its task back to the Lead. */
export async function handBack(a, h) {
    const { deps, project } = a;
    const task = a.seat.task ? a.state.tasks.get(a.seat.task) : undefined;
    if (!task)
        throw new SlpError(`${a.seat.name} has no task.`);
    if (task.state !== "running" && task.state !== "rework") {
        throw new SlpError(`Task ${task.id} is ${task.state}; wait for the Lead's letter.`);
    }
    if (!h.summary.trim())
        throw new SlpError("Say what you did: pass the summary as text or on stdin (-).");
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
    const lines = await changedLines(task.workdir, task.baseCommit, tip);
    const log = (await git(task.workdir, ["log", "--oneline", `${task.baseCommit}..${tip}`])).stdout.trim();
    await append(deps.env, project.id, () => ({
        kind: "task-done", task: task.id, outcome: h.outcome, summary: h.summary, checks: h.checks, leftUndone: h.left, head: tip,
    }));
    const text = [
        `Outcome: ${h.outcome}`, "", h.summary.trim(), "",
        "Checks:", ...(h.checks.length ? h.checks.map((c) => `- ${c}`) : ["- none"]),
        ...(h.left.trim() ? ["", `Left undone: ${h.left}`] : []),
        "", `Commits (${task.branch}):`, log || "(none)",
        `Changed: ${changed.join(", ") || "(nothing)"}`,
        ...(outside.length ? [`OUTSIDE owned paths (${task.owned.join(", ")}): ${outside.join(", ")}`] : []),
        ...(dirty.length ? [`Uncommitted: ${dirty.join(", ")}`] : []),
        // Catalogue 12 fallback: a large change suggests a clean-context review.
        ...(lines >= REVIEW_LINES ? [`Large change (${lines} lines): consider \`slp start-review --task ${task.id}\` before accepting.`] : []),
        "", `See the change: slp diff ${task.id}`,
    ].join("\n");
    await sendLetter(deps, project.id, { letter: "HANDBACK", from: a.seat.name, to: task.lane, lane: task.lane, task: task.id, text });
}
async function finishSeat(a, task, reason) {
    const seat = a.state.seats.get(task.seat);
    if (seat?.live)
        await closeSeat(a.deps, a.project.id, seat, reason);
    // A seat already gone may still leave its pane behind.
    else if (seat)
        await a.deps.herdr.paneClose(seat.paneId).catch(() => undefined);
}
export async function acceptTask(a, id, note) {
    const { deps, project } = a;
    const task = taskOfLead(a, id);
    const lane = laneOf(a);
    if (task.state !== "handed-back")
        throw new SlpError(`Task ${id} is ${task.state}; only a handed-back task can be accepted.`);
    let merged = null;
    if (task.mode === "lane") {
        const dirty = await dirtyPaths(task.workdir);
        if (dirty.length)
            throw new SlpError(`The lane's working copy has uncommitted changes (${dirty.slice(0, 10).join(", ")}); rework ${id} to commit or discard them.`);
    }
    else {
        const writer = [...a.state.tasks.values()].find((t) => t.lane === lane.id && t.mode === "lane" && (t.state === "running" || t.state === "rework"));
        if (writer)
            throw new SlpError(`${writer.id} is writing in the lane's working copy; accept ${id} once it hands back.`);
        for (const dir of [task.workdir, lane.workdir]) {
            const dirty = await dirtyPaths(dir);
            if (dirty.length)
                throw new SlpError(`Uncommitted changes in ${dir} (${dirty.slice(0, 10).join(", ")}); they must be committed or discarded first.`);
        }
        const result = await mergeInto(lane.workdir, task.branch, `Merge ${id}: ${task.title}`);
        if (!result.ok) {
            throw new SlpError(`${task.branch} conflicts with ${lane.branch} in: ${result.conflicts.join(", ")}. ` +
                `Nothing was merged. Cut ${id} and redo it on the lane's copy, or rework it narrower.`);
        }
        merged = await head(lane.workdir);
    }
    await append(deps.env, project.id, () => ({ kind: "task-accept", task: id, note, merged }));
    await finishSeat(a, task, `task ${id} accepted`);
    let kept = "";
    if (task.mode === "parallel") {
        if (await removeWorktree(project.root, task.workdir))
            await git(project.root, ["branch", "-D", task.branch]);
        else
            kept = `; its worktree changed since and was kept: ${task.workdir}`;
    }
    deps.out(`${id} accepted${merged ? ` and merged into ${lane.branch}` : ""}${kept}`);
}
export async function reworkTask(a, id, text) {
    const task = taskOfLead(a, id);
    if (task.state !== "handed-back")
        throw new SlpError(`Task ${id} is ${task.state}; only a handed-back task can be sent back.`);
    if (!text.trim())
        throw new SlpError("Say what to change and why.");
    if (!a.state.seats.get(task.seat)?.live)
        throw new SlpError(`${task.seat} is closed; cut ${id} and start a new task.`);
    await append(a.deps.env, a.project.id, () => ({ kind: "task-rework", task: id, note: text }));
    await sendLetter(a.deps, a.project.id, { letter: "REWORK", from: a.seat.name, to: task.seat, lane: task.lane, task: id, text });
}
export async function cutTask(a, id, reason) {
    const task = taskOfLead(a, id);
    if (!ACTIVE.has(task.state))
        throw new SlpError(`Task ${id} is already ${task.state}.`);
    if (!reason.trim())
        throw new SlpError("Say why the task is cut.");
    await append(a.deps.env, a.project.id, () => ({ kind: "task-cut", task: id, reason }));
    await finishSeat(a, task, `task ${id} cut`);
    if (task.mode === "parallel") {
        const removed = await removeWorktree(a.project.root, task.workdir);
        a.deps.out(`${id} cut; its branch ${task.branch} is kept` +
            (removed ? "" : `, and so is its worktree, which has uncommitted changes: ${task.workdir}`));
        return;
    }
    const dirty = await dirtyPaths(task.workdir);
    a.deps.out(`${id} cut. Its commits stay on ${task.branch}` +
        (dirty.length ? `; uncommitted changes remain in the lane's copy (${dirty.slice(0, 10).join(", ")})` : "") +
        ". Undo them with a new task if they are unwanted.");
}
export async function startReview(a, config, target, focus) {
    const { deps, project } = a;
    const lane = laneOf(a);
    if ((target.task === null) === !target.lane)
        throw new SlpError("Review one thing: --task L1-T2 or --lane.");
    let range;
    let cwd = lane.workdir;
    let what;
    let acceptance;
    if (target.task) {
        const task = taskOfLead(a, target.task);
        if (task.state !== "handed-back")
            throw new SlpError(`Task ${task.id} is ${task.state}; review a handed-back task.`);
        range = `${task.baseCommit}..${task.lastDone?.head ?? task.branch}`;
        if (task.mode === "parallel")
            cwd = task.workdir;
        what = `task ${task.id}: ${task.title}\nGoal: ${task.goal}`;
        acceptance = task.acceptance;
    }
    else {
        range = `${lane.baseCommit}..${lane.branch}`;
        what = `lane ${lane.id}: ${lane.title}\nOutcome: ${lane.outcome}`;
        acceptance = lane.acceptance;
    }
    const reviewHead = target.task ? await head(cwd).catch(() => undefined) : await head(project.root, lane.branch);
    const started = await append(deps.env, project.id, (events) => {
        const id = `${lane.id}-R${[...fold(events).reviews.values()].filter((r) => r.lane === lane.id).length + 1}`;
        return { kind: "review-start", lane: lane.id, review: id, target: target.task ?? lane.id, focus, seat: id, head: reviewHead };
    });
    const id = started.review;
    const text = [
        `Review ${what}`, "", "Acceptance:", ...acceptance.map((x) => `- ${x}`), "",
        `The change: slp diff ${target.task ?? lane.id}   (${range})`, `Working copy: ${cwd} (read only)`,
        ...(focus.trim() ? ["", `Focus: ${focus}`] : []),
    ].join("\n");
    try {
        const opened = await openSeat(deps, project, config, {
            name: id, role: "reviewer", lane: lane.id, task: target.task, cwd,
            place: { kind: "split", from: a.seat.paneId, direction: "down" },
            intro: intro(id, "reviewer", ` (lane ${lane.id})`, "claude"),
            brief: { letter: "REVIEW", from: a.seat.name, text },
        });
        if (opened.attention)
            deps.out(`NEEDS ATTENTION: ${opened.attention}`);
    }
    catch (error) {
        await append(deps.env, project.id, () => ({ kind: "review-done", review: id, summary: `not run: ${describe(error)}`, findings: [] }));
        throw error;
    }
}
const SEVERITY = { high: 0, medium: 1, low: 2 };
export function parseFinding(raw) {
    const parts = raw.split("::").map((p) => p.trim());
    const severity = parts[0]?.toLowerCase();
    if (parts.length !== 4 || (severity !== "high" && severity !== "medium" && severity !== "low") || parts.some((p) => !p)) {
        throw new SlpError(`A finding is "high|medium|low :: where :: what :: evidence", got: ${raw}`);
    }
    return { severity, where: parts[1], what: parts[2], evidence: parts[3] };
}
/** A Reviewer reports. */
export async function finishReview(a, summary, findings) {
    const review = [...a.state.reviews.values()].find((r) => r.seat === a.seat.name && !r.done);
    if (!review)
        throw new SlpError(`${a.seat.name} has no open review.`);
    if (!summary.trim())
        throw new SlpError("Say what you checked and how: pass it as text or on stdin (-).");
    await append(a.deps.env, a.project.id, () => ({ kind: "review-done", review: review.id, summary, findings }));
    const text = [
        summary.trim(), "",
        findings.length ? `Findings (${findings.length}):` : "No findings.",
        ...[...findings].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.what}\n   evidence: ${f.evidence}`),
    ].join("\n");
    await sendLetter(a.deps, a.project.id, { letter: "FINDINGS", from: a.seat.name, to: review.lane, lane: review.lane,
        task: a.seat.task, text });
    // The watcher closes this seat once its turn ends (closing it here would
    // kill the agent in the middle of this command).
    a.deps.out("Review recorded and sent. You are done; this seat closes shortly.");
}
/** Show a task's or a lane's change, so Leads and Reviewers need no git of their own. */
export async function diffOf(a, target) {
    const lane = laneOf(a);
    let cwd;
    let range;
    if (target === lane.id) {
        cwd = lane.workdir;
        range = `${lane.base}...${lane.branch}`;
    }
    else {
        const task = a.state.tasks.get(target);
        if (!task || task.lane !== lane.id)
            throw new SlpError(`No task ${target} in lane ${lane.id} (or name the lane: ${lane.id})`);
        const live = task.mode === "lane" || ACTIVE.has(task.state);
        cwd = live ? task.workdir : lane.workdir;
        range = `${task.baseCommit}..${task.lastDone?.head ?? (live ? "HEAD" : task.branch)}`;
    }
    const stat = await git(cwd, ["diff", "--stat", range]);
    if (stat.code !== 0)
        throw new SlpError(`git diff ${range} failed: ${stat.stderr.trim()}`);
    const full = (await git(cwd, ["diff", range])).stdout;
    const limit = 200_000;
    return `$ git diff ${range}   (in ${cwd})\n\n${stat.stdout.trim() || "(no changes)"}\n\n` +
        (full.length > limit ? `${full.slice(0, limit)}\n[slp] diff cut at ${limit} characters; read the files for the rest.` : full);
}
/**
 * Run the project's gate on a task's or the lane's copy, for a Lead or
 * Reviewer judging the work. Bounded well below an agent's command limit;
 * the full gate still runs when the lane reports ready.
 */
export async function testOf(a, target) {
    const lane = laneOf(a);
    let cwd = lane.workdir;
    const name = target ?? (a.seat.role === "reviewer" ? a.seat.task : null) ?? lane.id;
    if (name !== lane.id) {
        const task = a.state.tasks.get(name);
        if (!task || task.lane !== lane.id)
            throw new SlpError(`No task ${name} in lane ${lane.id} (or name the lane: ${lane.id})`);
        if (task.mode === "parallel" && ACTIVE.has(task.state))
            cwd = task.workdir;
    }
    const command = a.state.settings.gate ?? await detectGate(cwd);
    if (!command)
        return "No gate configured: the Supervisor sets one with `slp set-project --gate \"...\"`.";
    const result = await runGate(command, cwd, Math.min(a.state.settings.gateTimeoutMinutes, 8) * 60_000);
    return `$ ${command}   (in ${cwd})\n${result.ok ? "PASSED" : "FAILED"} in ${Math.round(result.durationMs / 1000)}s\n\n${result.tail}`;
}
