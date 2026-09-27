import { join } from "node:path";
import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import { contextPath } from "./core/project.js";
import { addWorktree, currentBranch, dirtyPaths, git, gitOk, head, removeWorktree } from "./git.js";
import { isCatchAll, overlaps } from "./globs.js";
import { intro } from "./guide.js";
import { sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { fold, liveSeats } from "./state.js";
function slug(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "lane";
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
function directive(project, deps, lane) {
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
        `Concept (the Human's word, read-only for you): ${contextPath(deps.env, project.id)}`,
        ...(lane.humanWords ? ["", "The Human asked:", lane.humanWords] : []),
    ].join("\n");
}
export async function openLane(deps, project, config, input) {
    if (!input.title.trim() || !input.outcome.trim())
        throw new SlpError("A lane needs --title and --outcome.");
    if (!input.acceptance.length)
        throw new SlpError("A lane needs acceptance: --accept \"...\" (repeatable).");
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
    }
    else {
        workdir = join(projectDir(deps.env, project.id), "slots", id);
        await addWorktree(project.root, workdir, branch, base);
    }
    await append(deps.env, project.id, () => ({
        kind: "lane-open", lane: id, title: input.title, outcome: input.outcome, acceptance: input.acceptance,
        outOfScope: input.outOfScope, writeSet: input.writeSet, branch, workdir, inCheckout, base, baseCommit,
        humanWords: input.humanWords,
    }));
    const lane = fold(await readLedger(deps.env, project.id)).lanes.get(id);
    deps.out(`lane ${id} opened on ${branch} (${inCheckout ? "your checkout" : workdir})`);
    const lead = await openSeat(deps, project, config, {
        name: id, role: "lead", lane: id, task: null, cwd: workdir, place: { kind: "tab", label: `${id} ${input.title}`.slice(0, 40) },
        intro: intro(id, "lead", ` (lane ${id}: ${input.title})`, config.launchers[config.roles.lead.use[0]]?.agent ?? "claude"),
    });
    if (lead.attention)
        deps.out(`NEEDS ATTENTION: ${lead.attention}`);
    await sendLetter(deps, project.id, { letter: "DIRECTIVE", from: "sup", to: id, text: directive(project, deps, lane), lane: id });
    if (input.humanWords.trim()) {
        const critic = await openSeat(deps, project, config, {
            name: `${id}-critic`, role: "critic", lane: id, task: null, cwd: project.root,
            place: { kind: "split", from: lead.seat.paneId, direction: "down" },
            intro: intro(`${id}-critic`, "critic", ` (lane ${id})`, config.launchers[config.roles.critic.use[0]]?.agent ?? "claude"),
        });
        if (critic.attention)
            deps.out(`NEEDS ATTENTION: ${critic.attention}`);
        await sendLetter(deps, project.id, {
            letter: "MESSAGE", from: "slp", to: `${id}-critic`, lane: id,
            text: [
                "Read this lane against the Human's own words and CONTEXT.md, then report with `slp findings`.",
                "", "The Human's words:", input.humanWords, "",
                `CONTEXT.md: ${contextPath(deps.env, project.id)}`, "",
                "The lane:", directive(project, deps, lane),
            ].join("\n"),
        });
    }
    return lane;
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
/** Close a lane's seats (and its tab), and put the Human's checkout back on base. */
export async function teardownLane(deps, project, lane, state) {
    for (const seat of liveSeats(state).filter((s) => s.lane === lane.id))
        await closeSeat(deps, project.id, seat, `lane ${lane.id} closed`);
    const tab = state.seats.get(lane.id)?.tabId;
    if (tab && tab !== project.mainTabId)
        await deps.herdr.tabClose(tab).catch(() => undefined);
    for (const task of state.tasks.values()) {
        if (task.lane === lane.id && task.mode === "parallel")
            await removeWorktree(project.root, task.workdir);
    }
    if (lane.inCheckout) {
        const r = await git(project.root, ["checkout", lane.base]);
        if (r.code !== 0)
            deps.out(`Could not switch your checkout back to ${lane.base}: ${r.stderr.trim()}`);
    }
    else {
        await removeWorktree(project.root, lane.workdir);
    }
}
/** Drop a lane without landing: seats closed, its branch kept for the record. */
export async function dropLane(deps, project, laneId, reason) {
    const state = fold(await readLedger(deps.env, project.id));
    const lane = state.lanes.get(laneId);
    if (!lane || !lane.open)
        throw new SlpError(`No open lane ${laneId}`);
    if (!reason.trim())
        throw new SlpError("Say why: --reason \"...\"");
    if (lane.inCheckout && (await dirtyPaths(project.root)).length) {
        throw new SlpError(`Lane ${laneId} has uncommitted changes in the checkout; a Peer must commit or discard them first.`);
    }
    await teardownLane(deps, project, lane, state);
    await append(deps.env, project.id, () => ({ kind: "lane-close", lane: laneId, landed: false, reason, commit: null, overGate: false }));
    deps.out(`lane ${laneId} dropped; branch ${lane.branch} kept`);
}
