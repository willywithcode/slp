import { append, readLedger } from "./core/ledger.js";
import { detectGate, runGate } from "./gate.js";
import { dirtyPaths, git, gitOk, head, mergeInto, squashCommit, treeOf, worktrees } from "./git.js";
import { teardownLane } from "./lanes.js";
import { sendLetter } from "./letters.js";
import { fold, leadOf } from "./state.js";
// Work the watcher does on a seat's behalf (ADR 0008): run the gate for a
// ready report, and land a lane. Both can take minutes, longer than an agent's
// shell command may run, so seats only record a request.
export function pendingRequests(events) {
    const done = new Set(events.flatMap((e) => (e.kind === "request-done" ? [e.request] : [])));
    return events.filter((e) => e.kind === "request" && !done.has(e.request));
}
async function gateFor(deps, project, state, lane) {
    const command = state.settings.gate ?? await detectGate(lane.workdir);
    if (!command)
        return null;
    deps.out(`gate for ${lane.id}: ${command}`);
    const result = await runGate(command, lane.workdir, state.settings.gateTimeoutMinutes * 60_000);
    await append(deps.env, project.id, () => ({
        kind: "gate", lane: lane.id, command, ok: result.ok, tail: result.tail, durationMs: result.durationMs,
    }));
    return { command, result };
}
function gateText(g) {
    if (!g)
        return "Gate: none configured (set one with `slp set-project --gate \"...\"`).";
    const secs = Math.round(g.result.durationMs / 1000);
    return `Gate \`${g.command}\`: ${g.result.ok ? "GREEN" : "RED"} (${secs}s)${g.result.ok ? "" : `\n\n${g.result.tail}`}`;
}
async function finish(deps, project, request, ok, detail) {
    await append(deps.env, project.id, () => ({ kind: "request-done", request, ok, detail }));
}
/** Tell the lane's Lead (if any) and the Supervisor. */
async function tell(deps, project, state, lane, toSup, toLead) {
    await sendLetter(deps, project.id, { letter: "REPORT", from: "slp", to: state.seats.get("sup")?.live ? "sup" : "human", lane: lane.id, text: toSup })
        .catch((error) => deps.out(`could not tell the Supervisor: ${String(error)}`));
    const lead = leadOf(state, lane.id);
    if (toLead && lead) {
        await sendLetter(deps, project.id, { letter: "NOTICE", from: "slp", to: lead.name, lane: lane.id, text: toLead })
            .catch((error) => deps.out(`could not tell ${lead.name}: ${String(error)}`));
    }
}
export async function runRequest(deps, project, req) {
    const state = fold(await readLedger(deps.env, project.id));
    const lane = state.lanes.get(req.lane);
    if (!lane || !lane.open) {
        await finish(deps, project, req.request, false, `lane ${req.lane} is not open`);
        return;
    }
    if (req.what === "ready") {
        const gate = await gateFor(deps, project, state, lane);
        const ok = gate?.result.ok ?? true;
        await finish(deps, project, req.request, ok, gateText(gate));
        await tell(deps, project, state, lane, `${lane.id} reports READY: ${req.note}\n\n${gateText(gate)}`, ok ? null : `The gate is red for ${lane.id}; the Supervisor was told. Fix it and report ready again.\n\n${gateText(gate)}`);
        return;
    }
    await land(deps, project, state, lane, req);
}
async function land(deps, project, state, lane, req) {
    const fail = async (why, toLead) => {
        await finish(deps, project, req.request, false, why);
        await tell(deps, project, state, lane, `Could not land ${lane.id}: ${why}`, toLead ? `Landing ${lane.id} failed: ${why}` : null);
    };
    const busy = [...state.tasks.values()].filter((t) => t.lane === lane.id && ["running", "handed-back", "rework"].includes(t.state));
    if (busy.length)
        return fail(`tasks still open (${busy.map((t) => `${t.id} ${t.state}`).join(", ")})`, true);
    const dirty = await dirtyPaths(lane.workdir);
    if (dirty.length)
        return fail(`uncommitted changes in ${lane.workdir}: ${dirty.slice(0, 10).join(", ")}`, true);
    const root = project.root;
    const baseCheckout = (await worktrees(root)).find((w) => w.branch === lane.base);
    if (baseCheckout && (await dirtyPaths(baseCheckout.path)).length) {
        return fail(`${lane.base} is checked out at ${baseCheckout.path} with uncommitted changes; the Human must commit or stash them`, false);
    }
    // Bring the lane up to date with base, so the gate tests what will land.
    const upToDate = (await git(root, ["merge-base", "--is-ancestor", lane.base, lane.branch])).code === 0;
    if (!upToDate) {
        const merged = await mergeInto(lane.workdir, lane.base, `Merge ${lane.base} into ${lane.branch}`);
        if (!merged.ok)
            return fail(`${lane.base} conflicts with the lane in ${merged.conflicts.join(", ")}; a Peer must reconcile them`, true);
    }
    const gate = await gateFor(deps, project, state, lane);
    if (gate && !gate.result.ok && !req.overGate)
        return fail(`the gate is red.\n\n${gateText(gate)}`, true);
    const baseHead = await head(root, lane.base);
    let commit = baseHead;
    if ((await treeOf(root, lane.branch)) !== (await treeOf(root, baseHead))) {
        const message = `${lane.title}\n\n${lane.outcome}\n\nLanded by slp from lane ${lane.id} (${lane.branch}).` +
            (req.overGate ? `\nLanded over a red gate: ${req.note}` : "");
        commit = await squashCommit(root, lane.branch, baseHead, message);
        if (baseCheckout)
            await gitOk(baseCheckout.path, ["merge", "--ff-only", commit]);
        else
            await gitOk(root, ["update-ref", `refs/heads/${lane.base}`, commit, baseHead]);
    }
    await teardownLane(deps, project, lane, state);
    await git(root, ["branch", "-D", lane.branch]);
    await append(deps.env, project.id, () => ({
        kind: "lane-close", lane: lane.id, landed: true, reason: req.note, commit, overGate: req.overGate,
    }));
    await finish(deps, project, req.request, true, `landed as ${commit.slice(0, 10)}`);
    const text = `${lane.id} landed on ${lane.base} as ${commit.slice(0, 10)}: ${lane.title}\n\n${gateText(gate)}` +
        (commit === baseHead ? "\n\n(The lane changed nothing; no commit was made.)" : "");
    await sendLetter(deps, project.id, { letter: "LANDED", from: "slp", to: state.seats.get("sup")?.live ? "sup" : "human", lane: lane.id, text })
        .catch((error) => deps.out(`could not tell the Supervisor: ${String(error)}`));
    await deps.herdr.notify(`slp: ${lane.id} landed`, `${lane.title} (${commit.slice(0, 10)}); not pushed`).catch(() => undefined);
}
