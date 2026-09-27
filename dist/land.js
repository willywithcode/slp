import { append, readLedger } from "./core/ledger.js";
import { detectGate, runGate } from "./gate.js";
import { dirtyPaths, git, head, mergeInto, squashCommit, treeOf, worktrees } from "./git.js";
import { teardownLane } from "./lanes.js";
import { loadConfig } from "./core/config.js";
import { consult } from "./jev/points.js";
import { LANDING } from "./jev/questions.js";
import { dataLossSigns, laneReviewed, laneRisky } from "./risk.js";
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
    if (lane && !lane.open && lane.landed && req.what === "land") {
        // Landed before a crash cut the rest short: finish tidying up.
        const problems = await teardownLane(deps, project, lane, state);
        await git(project.root, ["branch", "-D", lane.branch]);
        await finish(deps, project, req.request, true, `landed as ${lane.commit?.slice(0, 10)}${problems.length ? `; ${problems.join("; ")}` : ""}`);
        return;
    }
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
    // Pin the base now: the lane is brought up to date with exactly this commit,
    // the gate tests the result, and the squash goes on top of it. If the base
    // moves meanwhile, the update below refuses rather than undo those commits.
    const baseHead = await head(root, lane.base);
    const lanePre = await head(root, lane.branch);
    const upToDate = (await git(root, ["merge-base", "--is-ancestor", baseHead, lanePre])).code === 0;
    if (!upToDate) {
        const merged = await mergeInto(lane.workdir, baseHead, `Merge ${lane.base} into ${lane.branch}`);
        if (!merged.ok)
            return fail(`${lane.base} conflicts with the lane in ${merged.conflicts.join(", ")}; a Peer must reconcile them`, true);
    }
    // Pin the lane too: exactly this commit is tested, scanned and landed.
    const tip = await head(root, lane.branch);
    const gate = await gateFor(deps, project, state, lane);
    if (gate && !gate.result.ok && !req.overGate)
        return fail(`the gate is red.\n\n${gateText(gate)}`, true);
    if ((await head(root, lane.branch)) !== tip)
        return fail(`the lane changed while it was being landed; land it again`, true);
    // Risk holds (catalogue 6, 16): code rules first; Jev may add a hold once calibrated.
    if (!req.overRisk) {
        const holds = [];
        const risky = laneRisky(lane);
        if (risky && !(await laneReviewed(root, state, lane, lanePre))) {
            holds.push(`it is a high-risk lane (${risky}) and its current work has had no review of the whole lane (its Lead: \`slp start-review --lane\`)`);
        }
        holds.push(...await dataLossSigns(root, baseHead, tip));
        const config = await loadConfig(deps.env).catch(() => null);
        const diff = (await git(root, ["diff", "-U2", `${baseHead}..${tip}`])).stdout;
        const reading = config ? await consult(deps, project.id, config, "landing", `${lane.id}@${tip}`, { lane: { title: lane.title, outcome: lane.outcome }, diff: diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n…` : diff }, LANDING) : null;
        if (reading?.trusted("data_loss_risk", "yes"))
            holds.push(`Jev reads a data-loss risk (${reading.answers.data_loss_risk.confidence.toFixed(2)})`);
        if (holds.length) {
            await deps.herdr.notify(`slp: ${lane.id} held for you`, holds.join("; ")).catch(() => undefined);
            return fail(`held for the Human: ${holds.join("; ")}. If the Human agrees to land it anyway: ` +
                `\`slp close-lane ${lane.id} --land --over-risk --reason "the Human agreed: ..."\``, false);
        }
    }
    let commit = baseHead;
    if ((await treeOf(root, tip)) !== (await treeOf(root, baseHead))) {
        const message = `${lane.title}\n\n${lane.outcome}\n\nLanded by slp from lane ${lane.id} (${lane.branch}).` +
            (req.overGate ? `\nLanded over a red gate: ${req.note}` : "") +
            (req.overRisk ? `\nLanded over a risk hold: ${req.note}` : "");
        commit = await squashCommit(root, tip, baseHead, message);
        const moved = async () => (await head(root, lane.base)) !== baseHead;
        if (await moved())
            return fail(`${lane.base} moved while the lane was being landed; land it again`, false);
        const update = baseCheckout
            ? await git(baseCheckout.path, ["merge", "--ff-only", commit])
            : await git(root, ["update-ref", `refs/heads/${lane.base}`, commit, baseHead]);
        if (update.code !== 0) {
            return fail(await moved() ? `${lane.base} moved while the lane was being landed; land it again`
                : `${lane.base} could not be moved: ${(update.stderr || update.stdout).trim()}`, false);
        }
    }
    // Recorded before tidying up, so a crash from here on is finished on restart.
    await append(deps.env, project.id, () => ({
        kind: "lane-close", lane: lane.id, landed: true, reason: req.note, commit, overGate: req.overGate,
    }));
    const problems = await teardownLane(deps, project, lane, state);
    const deleted = await git(root, ["branch", "-D", lane.branch]);
    if (deleted.code !== 0 && !problems.length)
        problems.push(`branch ${lane.branch} was kept: ${deleted.stderr.trim()}`);
    await finish(deps, project, req.request, true, `landed as ${commit.slice(0, 10)}${problems.length ? `; ${problems.join("; ")}` : ""}`);
    const text = `${lane.id} landed on ${lane.base} as ${commit.slice(0, 10)}: ${lane.title}\n\n${gateText(gate)}` +
        (commit === baseHead ? "\n\n(The lane changed nothing; no commit was made.)" : "") +
        (problems.length ? `\n\nThe Human must know:\n${problems.map((p) => `- ${p}`).join("\n")}` : "");
    if (problems.length)
        await deps.herdr.notify(`slp: ${lane.id} landed, with loose ends`, problems.join("\n")).catch(() => undefined);
    await sendLetter(deps, project.id, { letter: "LANDED", from: "slp", to: state.seats.get("sup")?.live ? "sup" : "human", lane: lane.id, text })
        .catch((error) => deps.out(`could not tell the Supervisor: ${String(error)}`));
    await deps.herdr.notify(`slp: ${lane.id} landed`, `${lane.title} (${commit.slice(0, 10)}); not pushed`).catch(() => undefined);
}
