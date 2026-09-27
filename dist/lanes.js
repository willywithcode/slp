import { join } from "node:path";
import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import { contextPath } from "./core/project.js";
import { readFile } from "node:fs/promises";
import { criticPrefilter } from "./jev/desk.js";
import { addWorktree, currentBranch, dirtyPaths, git, gitOk, head, removeWorktree } from "./git.js";
import { isCatchAll, overlaps } from "./globs.js";
import { intro } from "./guide.js";
import { describe, sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { humanWordsSince } from "./watch/transcripts.js";
import { laneRisky } from "./risk.js";
import { fold, liveSeats } from "./state.js";
function slug(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/^-+|-+$/g, "") || "lane";
}
export function checkWriteSet(state, writeSet, except) {
    if (!writeSet.length)
        throw new SlpError("A lane needs a write set: --write \"src/area/**\" (repeatable).");
    const wide = writeSet.filter(isCatchAll);
    if (wide.length)
        throw new SlpError(`Write set too wide (${wide.join(", ")}): name the areas this outcome changes.`);
    for (const lane of state.lanes.values()) {
        if (!lane.open || lane.id === except)
            continue;
        if (overlaps(writeSet, lane.writeSet)) {
            throw new SlpError(`Write set overlaps open lane ${lane.id} (${lane.writeSet.join(", ")}). ` +
                `Amend ${lane.id} instead, or wait for it to close.`);
        }
    }
}
function directive(lane) {
    const lines = [
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
    ];
    const risky = laneRisky(lane);
    if (risky)
        lines.push("", `High-risk lane (${risky}): get a review of the whole lane (\`slp start-review --lane\`) before reporting ready; slp holds the landing until then.`);
    return lines.join("\n");
}
export async function openLane(deps, project, config, input) {
    if (!input.title.trim() || !input.outcome.trim())
        throw new SlpError("A lane needs --title and --outcome.");
    if (!input.acceptance.length)
        throw new SlpError("A lane needs acceptance: --accept \"...\" (repeatable).");
    const before = fold(await readLedger(deps.env, project.id));
    const base = before.settings.base;
    const baseCommit = await head(project.root, base);
    // The Human's own words since the last lane (from the Supervisor's
    // transcript), else what the Supervisor quoted.
    const sup = before.seats.get("sup");
    const since = [...before.lanes.values()].at(-1)?.openedAt ?? sup?.openedAt ?? new Date(0).toISOString();
    const typed = sup?.sessionId ? await humanWordsSince(deps.env, sup.sessionId, since).catch(() => []) : [];
    const humanWords = typed.length ? typed.join("\n\n") : input.humanWords;
    const onBase = (await currentBranch(project.root)) === base;
    const clean = (await dirtyPaths(project.root)).length === 0;
    const slots = join(projectDir(deps.env, project.id), "slots");
    // The lane is reserved under the ledger lock (its id, write set and working
    // copy are decided against the current record), then its branch is made.
    // The first lane works in the Human's checkout; later or isolated lanes get
    // a worktree of their own (ADR 0008).
    const opened = await append(deps.env, project.id, (events) => {
        const state = fold(events);
        checkWriteSet(state, input.writeSet);
        const id = nextId(events, "lane-open", "L");
        const checkoutBusy = [...state.lanes.values()].some((l) => l.open && l.inCheckout);
        const inCheckout = !input.isolate && !checkoutBusy && onBase && clean;
        return {
            kind: "lane-open", lane: id, title: input.title, outcome: input.outcome, acceptance: input.acceptance,
            outOfScope: input.outOfScope, writeSet: input.writeSet, branch: `lane/${id}-${slug(input.title)}`,
            workdir: inCheckout ? project.root : join(slots, id), inCheckout, base, baseCommit, humanWords,
        };
    });
    const { lane: id, branch, workdir, inCheckout } = opened;
    try {
        if (inCheckout)
            await gitOk(project.root, ["checkout", "-b", branch, baseCommit]);
        else
            await addWorktree(project.root, workdir, branch, baseCommit);
    }
    catch (error) {
        await append(deps.env, project.id, () => ({
            kind: "lane-close", lane: id, landed: false, reason: `its branch could not be made: ${describe(error)}`, commit: null, overGate: false,
        }));
        throw error;
    }
    const lane = fold(await readLedger(deps.env, project.id)).lanes.get(id);
    deps.out(`lane ${id} opened on ${branch} (${inCheckout ? "your checkout" : workdir})`);
    const lead = await openSeat(deps, project, config, {
        name: id, role: "lead", lane: id, task: null, cwd: workdir, place: { kind: "tab", label: `${id} ${input.title}`.slice(0, 40) },
        intro: intro(id, "lead", ` (lane ${id}: ${input.title})`, config.launchers[config.roles.lead.use[0]]?.agent ?? "claude"),
        brief: { letter: "DIRECTIVE", from: "sup", text: directive(lane) },
    });
    if (lead.attention)
        deps.out(`NEEDS ATTENTION: ${lead.attention}`);
    if (lane.humanWords.trim())
        await openCritic(deps, project, config, lane, lead.seat.paneId);
    return lane;
}
/** A Critic reads the lane against the Human's words once (ADR 0007); the lane runs without one if it cannot open. */
async function openCritic(deps, project, config, lane, beside) {
    const name = `${lane.id}-critic`;
    try {
        // Catalogue 19: an optional machine first pass, context for the Critic only.
        const concept = await readFile(contextPath(deps.env, project.id), "utf8").catch(() => "");
        const first = await criticPrefilter(deps, project.id, config, lane, concept).catch(() => null);
        const critic = await openSeat(deps, project, config, {
            name, role: "critic", lane: lane.id, task: null, cwd: lane.workdir,
            place: { kind: "split", from: beside, direction: "down" },
            intro: intro(name, "critic", ` (lane ${lane.id})`, config.launchers[config.roles.critic.use[0]]?.agent ?? "claude"),
            brief: {
                letter: "MESSAGE", from: "slp",
                text: [
                    "Read this lane against the Human's own words and the concept (`slp context`), then report with `slp findings`.",
                    "", "The Human's words:", lane.humanWords, "", "The lane:", directive(lane),
                    ...(first ? ["", first] : []),
                ].join("\n"),
            },
        });
        if (critic.attention)
            deps.out(`NEEDS ATTENTION: ${critic.attention}`);
    }
    catch (error) {
        deps.out(`The Critic for ${lane.id} could not open (${describe(error)}); the lane runs without it.`);
    }
}
export async function amendLane(deps, project, laneId, a) {
    const state = fold(await readLedger(deps.env, project.id));
    const lane = state.lanes.get(laneId);
    if (!lane || !lane.open)
        throw new SlpError(`No open lane ${laneId}`);
    if (!a.why.trim())
        throw new SlpError("Say why: --why \"...\"");
    if (a.writeSet)
        checkWriteSet(state, a.writeSet, laneId);
    await append(deps.env, project.id, () => ({
        kind: "lane-amend", lane: laneId, why: a.why,
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
/**
 * Close a lane's seats and tab, remove its worktrees, and put the Human's
 * checkout back on base. Safe to run again (after a crash). Never discards
 * work: a worktree with uncommitted changes is kept. Returns what the Human
 * must know (things it could not do).
 */
export async function teardownLane(deps, project, lane, state) {
    const problems = [];
    for (const seat of liveSeats(state).filter((s) => s.lane === lane.id))
        await closeSeat(deps, project.id, seat, `lane ${lane.id} closed`);
    const tab = state.seats.get(lane.id)?.tabId;
    if (tab && tab !== project.mainTabId)
        await deps.herdr.tabClose(tab).catch(() => undefined);
    for (const task of state.tasks.values()) {
        if (task.lane !== lane.id || task.mode !== "parallel")
            continue;
        if (!(await removeWorktree(project.root, task.workdir)))
            problems.push(`${task.id}'s worktree has uncommitted changes and was kept: ${task.workdir}`);
    }
    if (lane.inCheckout) {
        // Only if the checkout is still on this lane's branch; never move the Human elsewhere.
        if ((await currentBranch(project.root)) === lane.branch) {
            const r = await git(project.root, ["checkout", lane.base]);
            if (r.code !== 0)
                problems.push(`your checkout is still on ${lane.branch}; switch it back with \`git checkout ${lane.base}\` (${r.stderr.trim()})`);
        }
    }
    else if (!(await removeWorktree(project.root, lane.workdir))) {
        problems.push(`${lane.id}'s worktree has uncommitted changes and was kept: ${lane.workdir}`);
    }
    return problems;
}
/** Uncommitted work anywhere in a lane: its copy and its parallel tasks' copies. */
export async function laneDirt(state, lane) {
    const found = [];
    const copies = [lane.workdir, ...[...state.tasks.values()].filter((t) => t.lane === lane.id && t.mode === "parallel" && ["running", "handed-back", "rework"].includes(t.state)).map((t) => t.workdir)];
    for (const dir of copies) {
        const dirty = await dirtyPaths(dir).catch(() => []);
        if (dirty.length)
            found.push(`${dir}: ${dirty.slice(0, 6).join(", ")}`);
    }
    return found;
}
/** Drop a lane without landing: seats closed, its branch kept for the record. */
export async function dropLane(deps, project, laneId, reason) {
    const state = fold(await readLedger(deps.env, project.id));
    const lane = state.lanes.get(laneId);
    if (!lane || !lane.open)
        throw new SlpError(`No open lane ${laneId}`);
    if (!reason.trim())
        throw new SlpError("Say why: --reason \"...\"");
    const dirt = await laneDirt(state, lane);
    if (dirt.length) {
        throw new SlpError(`Lane ${laneId} has uncommitted work (${dirt.join("; ")}). Have its Lead get it committed or discarded, then drop it.`);
    }
    // Recorded first, so a crash mid-teardown leaves a closed lane the watcher tidies.
    await append(deps.env, project.id, () => ({ kind: "lane-close", lane: laneId, landed: false, reason, commit: null, overGate: false }));
    const problems = await teardownLane(deps, project, lane, state);
    deps.out(`lane ${laneId} dropped; branch ${lane.branch} kept${problems.length ? `\n${problems.join("\n")}` : ""}`);
}
