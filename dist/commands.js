import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { foldCases } from "./cases.js";
import { Herdr, HerdrError } from "./herdr.js";
import { acquireLock, appendEvent, isMessage, nextCaseId, readEvents } from "./log.js";
import { envelope, onboarding } from "./protocol.js";
import { loadRoom, MEMBER_NAME, resolveRoom, resolveSelf, RoomGoneError, roomDir, saveRoom, splHome, SplError, } from "./room.js";
// Command-line arguments are limited (~32k chars on Windows). Longer messages
// are stored in the room and the target is pointed at the file instead.
export const INLINE_LIMIT = 6_000;
// ---------------------------------------------------------------- up
/**
 * Native arguments that let each agent kind run `spl` without an approval
 * dialog per call, which would leave it `blocked`. Only `spl` is allowed;
 * everything else keeps the agent's normal permission behaviour.
 */
export function agentArgs(kind, env) {
    if (kind === "claude")
        return ["--allowedTools", "Bash(spl *)"];
    // Codex's sandbox must be able to write the room log.
    if (kind === "codex")
        return ["--add-dir", splHome(env)];
    return [];
}
export async function up(deps, o) {
    const dir = roomDir(deps.env, o.room); // validates the name
    if (o.peers.length < 1 || o.peers.length > 8)
        throw new SplError("A room needs 1 to 8 peers");
    // Reserve the name atomically before creating anything in Herdr.
    await mkdir(dirname(dir), { recursive: true });
    try {
        await mkdir(dir);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        if (await loadRoom(deps.env, o.room))
            throw new SplError(`Room "${o.room}" already exists`);
        throw new SplError(`Room "${o.room}" is being created by another \`spl up\`, or an earlier one failed. ` +
            `If no other \`spl up\` is running, remove ${dir} and retry.`);
    }
    let workspaceId = null;
    try {
        return await createRoom(deps, o, (id) => { workspaceId = id; });
    }
    catch (error) {
        // Nothing usable was saved: free the name. A created workspace is left
        // for the human to inspect or close; spl only reports it.
        if (!(await loadRoom(deps.env, o.room).catch(() => null)))
            await rm(dir, { recursive: true, force: true });
        if (workspaceId)
            deps.out(`spl up failed after creating workspace ${workspaceId}; close it with \`herdr workspace close ${workspaceId}\`.`);
        throw error;
    }
}
async function createRoom(deps, o, created) {
    const cwd = resolve(o.cwd);
    const plan = [
        { name: "lead", role: "lead", kind: o.lead },
        ...o.peers.map((kind, i) => ({ name: `p${i + 1}`, role: "peer", kind })),
        ...(o.supervisor ? [{ name: "sup", role: "supervisor", kind: o.supervisor }] : []),
    ];
    const paneEnv = { SPL_ROOM: o.room };
    // Layout: lead top-left, supervisor below it, peers stacked on the right.
    const ws = await deps.herdr.workspaceCreate({ cwd, label: `spl:${o.room}`, env: { SPL_ROOM: o.room } });
    created(ws.workspaceId);
    deps.out(`workspace ${ws.workspaceId} created`);
    const panes = new Map([["lead", ws.rootPaneId]]);
    let previousPeer = null;
    for (const m of plan) {
        if (m.role !== "peer")
            continue;
        const paneId = await deps.herdr.paneSplit(previousPeer ?? ws.rootPaneId, { direction: previousPeer ? "down" : "right", cwd, env: paneEnv });
        panes.set(m.name, paneId);
        previousPeer = paneId;
    }
    if (o.supervisor)
        panes.set("sup", await deps.herdr.paneSplit(ws.rootPaneId, { direction: "down", cwd, env: paneEnv }));
    const room = { version: 1, name: o.room, cwd, workspaceId: ws.workspaceId, createdAt: new Date().toISOString(), members: {} };
    for (const m of plan)
        room.members[m.name] = { role: m.role, kind: m.kind, herdrName: `${o.room}-${m.name}`, paneId: panes.get(m.name) };
    await saveRoom(deps.env, room);
    const roster = plan.map((m) => `${m.name} (${m.role}, ${m.kind})`).join(", ");
    for (const m of plan) {
        const member = room.members[m.name];
        const intro = onboarding(o.room, m.name, m.role, roster);
        try {
            await deps.herdr.agentStart(member.herdrName, m.kind, member.paneId, 60_000, agentArgs(m.kind, deps.env));
            await deps.herdr.prompt(member.herdrName, intro);
            deps.out(`${m.name}: ${m.kind} started as ${member.herdrName} in ${member.paneId}`);
        }
        catch (error) {
            // Typically a first-run trust/approval dialog. The room stays usable.
            deps.out(`${m.name}: NEEDS ATTENTION in pane ${member.paneId} (${describe(error)}).\n` +
                `  Resolve it there, then paste: ${intro}`);
        }
    }
    if (o.watch) {
        // The watcher gets a plain shell pane below the supervisor (or lead). It is
        // a convenience: if it fails, the room itself is still complete.
        try {
            const below = room.members.sup?.paneId ?? room.members.lead.paneId;
            const pane = await deps.herdr.paneSplit(below, { direction: "down", cwd, env: paneEnv });
            await deps.herdr.paneRun(pane, `spl watch --room ${o.room}`);
            deps.out(`watch: running in ${pane}`);
        }
        catch (error) {
            deps.out(`watch: NEEDS ATTENTION (${describe(error)}). Run \`spl watch --room ${o.room}\` in any terminal.`);
        }
    }
    return room;
}
// ---------------------------------------------------------------- down
/**
 * Close the room's workspace (ending its agents) and archive the room data
 * under rooms/.archive/. Only the human may do this: it is refused from any
 * pane of the room itself.
 */
export async function down(deps, name, force) {
    const room = await loadRoom(deps.env, name);
    if (!room)
        throw new SplError(`Room "${name}" does not exist`);
    const pane = deps.env.HERDR_PANE_ID;
    if (pane && Object.values(room.members).some((m) => m.paneId === pane)) {
        throw new SplError(`Refusing to close the room from inside room ${name}; run \`spl down ${name}\` from another terminal.`);
    }
    try {
        await deps.herdr.workspaceClose(room.workspaceId);
        deps.out(`workspace ${room.workspaceId} closed`);
    }
    catch (error) {
        if (!force) {
            throw new SplError(`Could not close workspace ${room.workspaceId}: ${describe(error)}. ` +
                `If it is already gone, run \`spl down ${name} --force\` to archive the room anyway.`);
        }
        deps.out(`workspace ${room.workspaceId} not closed (${describe(error)}); archiving anyway (--force)`);
    }
    const archive = join(dirname(roomDir(deps.env, name)), ".archive");
    await mkdir(archive, { recursive: true });
    const target = join(archive, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    // Hold the log lock across the move: no writer can be between its identity
    // check and its append while the room changes places. Writers waiting for
    // the lock then find the room gone (or replaced) instead of writing.
    await acquireLock(join(roomDir(deps.env, name), "events.lock"));
    await renameWithRetry(roomDir(deps.env, name), target);
    // Locks are process state, not history: drop them from the archive (the
    // watcher's is left behind when closing the workspace ends its process).
    for (const lock of ["events.lock", "watch.lock"])
        await rm(join(target, lock), { recursive: true, force: true });
    deps.out(`room ${name} archived to ${target}`);
    return target;
}
// Windows refuses to rename a directory while another process briefly holds a
// file in it (e.g. a watcher writing watch.json); such holds last milliseconds.
async function renameWithRetry(from, to) {
    for (let attempt = 1;; attempt++) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            const code = error.code;
            if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
                throw new SplError(`Could not archive ${from}: ${error.message}. Move it into ${dirname(to)} by hand.`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
    }
}
// ---------------------------------------------------------------- messages
export async function send(deps, roomFlag, to, text) {
    const self = await member(deps.env, roomFlag, "lead", "send a brief");
    peerOf(self.room, to);
    const event = await appendEvent(deps.env, self.room.name, (events) => ({
        kind: "brief", case: nextCaseId(events), from: self.name, to, text: nonEmpty(text),
    }), self.room);
    await deliver(deps, self.room, event);
    return event;
}
export async function handback(deps, roomFlag, caseId, text) {
    const self = await member(deps.env, roomFlag, "peer", "send a handback");
    const event = await appendEvent(deps.env, self.room.name, (events) => {
        const view = foldCases(events).get(caseId);
        if (!view)
            throw new SplError(`Unknown case ${caseId}`);
        // The briefed peer, and any peer the lead replied to on this case (e.g. a reviewer).
        if (!view.messages.some((m) => m.kind !== "handback" && m.to === self.name)) {
            throw new SplError(`Case ${caseId} was not addressed to ${self.name}`);
        }
        return { kind: "handback", case: caseId, from: self.name, to: view.lead, text: nonEmpty(text) };
    }, self.room);
    await deliver(deps, self.room, event);
    return event;
}
/** `close`: accept and close the case; the recipient then owes no handback. */
export async function reply(deps, roomFlag, caseId, to, text, close = false) {
    const self = await member(deps.env, roomFlag, "lead", "reply");
    peerOf(self.room, to);
    const event = await appendEvent(deps.env, self.room.name, (events) => {
        const view = foldCases(events).get(caseId);
        if (!view)
            throw new SplError(`Unknown case ${caseId}`);
        if (view.lead !== self.name)
            throw new SplError(`Case ${caseId} belongs to ${view.lead}`);
        return { kind: "reply", case: caseId, from: self.name, to, text: nonEmpty(text), ...(close ? { closes: true } : {}) };
    }, self.room);
    await deliver(deps, self.room, event);
    return event;
}
/**
 * Retry a message. Herdr has no idempotent prompt, so only a delivery Herdr
 * refused is retried by default; a delivered or unconfirmed one (the sender
 * may have crashed after Herdr accepted it) needs `force` after checking.
 */
export async function redeliver(deps, roomFlag, seq, force) {
    const self = await resolveSelf(deps.env, roomFlag);
    const events = await readEvents(deps.env, self.room.name);
    const event = events.find((e) => e.seq === seq);
    if (!event || !isMessage(event))
        throw new SplError(`No message with seq ${seq}`);
    if (event.from !== self.name)
        throw new SplError(`Message ${seq} was sent by ${event.from}; only its sender can redeliver it`);
    const view = foldCases(events).get(event.case);
    if (!force && !view?.failed.includes(seq)) {
        throw new SplError(view?.unconfirmed.includes(seq)
            ? `Message ${seq}'s delivery outcome is unknown; it may already be in ${event.to}'s pane. Check there first, then use \`spl redeliver --force ${seq}\` if it is missing.`
            : `Message ${seq} was already delivered to ${event.to}; use --force to send it again.`);
    }
    await deliver(deps, self.room, event);
}
/** Hand a recorded message to Herdr and record the outcome. Throws if not delivered. */
async function deliver(deps, room, event) {
    const target = room.members[event.to];
    if (!target)
        throw new SplError(`Unknown member ${event.to}`);
    let body = event.text;
    if (body.length > INLINE_LIMIT) {
        const dir = join(roomDir(deps.env, room.name), "messages");
        // Not recursive: if `spl down` archived the room meanwhile, fail instead of
        // recreating the room directory.
        await mkdir(dir).catch((error) => {
            if (error.code === "ENOENT")
                throw new RoomGoneError(`Room "${room.name}" no longer exists`);
            if (error.code !== "EEXIST")
                throw error;
        });
        const file = join(dir, `${event.seq}-${event.kind}-${event.case}.md`);
        await writeFile(file, event.text, "utf8");
        body = `The full message is long; read it from this file before acting:\n${file}`;
    }
    let error = null;
    try {
        // Pane IDs are also the identity key, and work even if the herdr name was
        // never assigned (e.g. the agent was started by hand after a dialog).
        await deps.herdr.prompt(target.paneId, envelope(event.kind, event.case, event.from, body, event.kind === "reply" && event.closes === true));
    }
    catch (e) {
        error = describe(e);
    }
    await appendEvent(deps.env, room.name, () => ({ kind: "delivery", ref: event.seq, ok: error === null, error }), room);
    if (error !== null) {
        throw new SplError(`${event.kind} ${event.case} was recorded as seq ${event.seq} but NOT delivered to ${event.to}: ${error}. ` +
            `Fix the cause, then run \`spl redeliver ${event.seq}\`.`);
    }
    deps.out(`${event.kind} ${event.case} (seq ${event.seq}) delivered to ${event.to}`);
}
// ---------------------------------------------------------------- views
export async function status(deps, roomFlag) {
    const room = await resolveRoom(deps.env, roomFlag);
    deps.out(`room ${room.name}  workspace ${room.workspaceId}  ${room.cwd}`);
    for (const [name, m] of Object.entries(room.members))
        deps.out(`  ${name.padEnd(5)} ${m.role.padEnd(10)} ${m.kind.padEnd(8)} ${m.paneId}`);
    const cases = [...foldCases(await readEvents(deps.env, room.name)).values()];
    if (!cases.length)
        return deps.out("no cases yet");
    deps.out("");
    for (const c of cases) {
        const last = c.messages.at(-1);
        const warn = (c.failed.length ? `  UNDELIVERED seq ${c.failed.join(",")}` : "") +
            (c.unconfirmed.length ? `  UNCONFIRMED seq ${c.unconfirmed.join(",")}` : "");
        deps.out(`${c.id.padEnd(5)} ${c.lead} -> ${c.peer.padEnd(4)} ${c.state.padEnd(18)} last ${last.kind} seq ${last.seq} ${last.ts}${warn}`);
    }
}
export async function log(deps, roomFlag, caseId) {
    const room = await resolveRoom(deps.env, roomFlag);
    const view = foldCases(await readEvents(deps.env, room.name)).get(caseId);
    if (!view)
        throw new SplError(`Unknown case ${caseId}`);
    for (const m of view.messages) {
        const flag = view.failed.includes(m.seq) ? `  (NOT DELIVERED: ${view.errors[m.seq]})` : view.unconfirmed.includes(m.seq) ? "  (DELIVERY UNCONFIRMED)" : "";
        deps.out(`--- seq ${m.seq} ${m.kind} ${m.from} -> ${m.to} ${m.ts}${flag}\n${m.text}\n`);
    }
}
// ---------------------------------------------------------------- helpers
async function member(env, roomFlag, role, action) {
    const self = await resolveSelf(env, roomFlag);
    if (self.member.role !== role)
        throw new SplError(`Only the ${role} can ${action}; you are ${self.name} (${self.member.role})`);
    return self;
}
function peerOf(room, name) {
    if (!MEMBER_NAME.test(name) || room.members[name]?.role !== "peer") {
        const peers = Object.entries(room.members).filter(([, m]) => m.role === "peer").map(([n]) => n);
        throw new SplError(`"${name}" is not a peer in room ${room.name} (peers: ${peers.join(", ")})`);
    }
}
function nonEmpty(text) {
    if (!text.trim())
        throw new SplError("Message text is empty");
    return text;
}
export function describe(error) {
    if (error instanceof HerdrError)
        return `${error.code}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}
