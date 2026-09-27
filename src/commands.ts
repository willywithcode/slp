import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { foldCases } from "./cases.js";
import { Herdr, HerdrError } from "./herdr.js";
import { acquireLock, appendEvent, isMessage, lockHeldByLiveProcess, nextCaseId, readEvents, type MessageEvent } from "./log.js";
import { envelope, onboarding } from "./protocol.js";
import {
  loadRoom, MEMBER_NAME, resolveRoom, resolveSelf, RoomGoneError, roomDir, saveRoom, slpHome, SplError,
  type Env, type Member, type Room, type Self,
} from "./room.js";

export interface Deps { env: Env; herdr: Herdr; out: (line: string) => void; now?: () => number; fetch?: typeof fetch }

// Command-line arguments are limited (~32k chars on Windows). Longer messages
// are stored in the room and the target is pointed at the file instead.
export const INLINE_LIMIT = 6_000;

// ---------------------------------------------------------------- up

/**
 * Native arguments that let each agent kind run `slp` without an approval
 * dialog per call, which would leave it `blocked`. Only `slp` is allowed;
 * everything else keeps the agent's normal permission behaviour.
 */
export function agentArgs(kind: string, env: Env): string[] {
  // slp.cmd too: on Windows an agent may call the .cmd shim explicitly.
  if (kind === "claude") return ["--allowedTools", "Bash(slp *)", "Bash(slp.cmd *)"];
  // Codex: its own process, not the shared background server, so commands
  // see this pane's HERDR_PANE_ID; workspace-write (Codex's normal mode for
  // trusted projects) so the Peer can edit code and --add-dir is honoured for
  // the room log. A read-only default makes Codex exit on --add-dir.
  if (kind === "codex") return ["--no-daemon", "--sandbox", "workspace-write", "--add-dir", slpHome(env)];
  return [];
}

/** Startup screens that only the human may answer (Claude Code, Codex). */
const STARTUP_DIALOG = /trust this folder|do you trust|one you trust|trust the files|trust and continue/i;

export interface UpOptions { room: string; cwd: string; lead: string; peers: string[]; supervisor: string | null; watch?: boolean }

export async function up(deps: Deps, o: UpOptions): Promise<Room> {
  const dir = roomDir(deps.env, o.room); // validates the name
  if (o.peers.length < 1 || o.peers.length > 8) throw new SplError("A room needs 1 to 8 peers");
  // Reserve the name atomically before creating anything in Herdr.
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await loadRoom(deps.env, o.room)) throw new SplError(`Room "${o.room}" already exists`);
    throw new SplError(`Room "${o.room}" is being created by another \`slp up\`, or an earlier one failed. ` +
      `If no other \`slp up\` is running, remove ${dir} and retry.`);
  }
  let workspaceId: string | null = null;
  try {
    return await createRoom(deps, o, (id) => { workspaceId = id; });
  } catch (error) {
    // Nothing usable was saved: free the name. A created workspace is left
    // for the human to inspect or close; slp only reports it.
    if (!(await loadRoom(deps.env, o.room).catch(() => null))) await rm(dir, { recursive: true, force: true });
    if (workspaceId) deps.out(`slp up failed after creating workspace ${workspaceId}; close it with \`herdr workspace close ${workspaceId}\`.`);
    throw error;
  }
}

async function createRoom(deps: Deps, o: UpOptions, created: (workspaceId: string) => void): Promise<Room> {
  const cwd = resolve(o.cwd);
  const plan: { name: string; role: Member["role"]; kind: string }[] = [
    { name: "lead", role: "lead", kind: o.lead },
    ...o.peers.map((kind, i) => ({ name: `p${i + 1}`, role: "peer" as const, kind })),
    ...(o.supervisor ? [{ name: "sup", role: "supervisor" as const, kind: o.supervisor }] : []),
  ];
  const paneEnv = { SLP_ROOM: o.room };

  // Layout: lead top-left, supervisor below it, peers stacked on the right.
  const ws = await deps.herdr.workspaceCreate({ cwd, label: `slp:${o.room}`, env: { SLP_ROOM: o.room } });
  created(ws.workspaceId);
  deps.out(`workspace ${ws.workspaceId} created`);
  const panes = new Map<string, string>([["lead", ws.rootPaneId]]);
  let previousPeer: string | null = null;
  for (const m of plan) {
    if (m.role !== "peer") continue;
    const paneId: string = await deps.herdr.paneSplit(previousPeer ?? ws.rootPaneId, { direction: previousPeer ? "down" : "right", cwd, env: paneEnv });
    panes.set(m.name, paneId);
    previousPeer = paneId;
  }
  if (o.supervisor) panes.set("sup", await deps.herdr.paneSplit(ws.rootPaneId, { direction: "down", cwd, env: paneEnv }));

  const room: Room = { version: 1, name: o.room, cwd, workspaceId: ws.workspaceId, createdAt: new Date().toISOString(), members: {} };
  for (const m of plan) room.members[m.name] = { role: m.role, kind: m.kind, herdrName: `${o.room}-${m.name}`, paneId: panes.get(m.name)! };
  await saveRoom(deps.env, room);

  const roster = plan.map((m) => `${m.name} (${m.role}, ${m.kind})`).join(", ");
  for (const m of plan) {
    const member = room.members[m.name]!;
    const intro = onboarding(o.room, m.name, m.role, roster, process.platform, m.kind);
    try {
      await startInFreePane(deps, room, m.name, cwd, paneEnv);
      // Herdr can report an agent ready while a folder-trust dialog is shown;
      // the prompt's Enter would then accept it on the human's behalf.
      if (STARTUP_DIALOG.test(await deps.herdr.agentRead(member.herdrName))) {
        throw new SplError("a folder-trust dialog is waiting for the human");
      }
      await deps.herdr.prompt(member.herdrName, intro);
      deps.out(`${m.name}: ${m.kind} started as ${member.herdrName} in ${member.paneId}`);
    } catch (error) {
      // Typically a first-run trust/approval dialog. The room stays usable.
      deps.out(`${m.name}: NEEDS ATTENTION in pane ${member.paneId} (${describe(error)}).\n` +
        `  Resolve it there, then paste: ${intro}`);
    }
  }
  if (o.watch) {
    // The watcher gets a plain shell pane below the supervisor (or lead). It is
    // a convenience: if it fails, the room itself is still complete.
    try {
      const below = room.members.sup?.paneId ?? room.members.lead!.paneId;
      const pane = await deps.herdr.paneSplit(below, { direction: "down", cwd, env: paneEnv });
      await deps.herdr.paneRun(pane, `slp watch --room ${o.room}`);
      deps.out(`watch: running in ${pane}`);
    } catch (error) {
      deps.out(`watch: NEEDS ATTENTION (${describe(error)}). Run \`slp watch --room ${o.room}\` in any terminal.`);
    }
  }
  return room;
}

/** `agent_pane_busy` retries; mutable only so tests need not wait. */
export const startRetry = { attempts: 6, delayMs: 1_000 };

/**
 * Start a member's agent. A pane whose shell is not ready yet is retried; one
 * that stays occupied (e.g. a stray process attached to a fresh pane's
 * console, seen live on Windows) is replaced by a new pane next to it, and
 * the room records the move.
 */
async function startInFreePane(deps: Deps, room: Room, name: string, cwd: string, env: Record<string, string>): Promise<void> {
  const member = room.members[name]!;
  const start = () => deps.herdr.agentStart(member.herdrName, member.kind, member.paneId, 60_000, agentArgs(member.kind, deps.env));
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy") throw error;
      if (attempt < startRetry.attempts) {
        await new Promise((resolve) => setTimeout(resolve, startRetry.delayMs));
        continue;
      }
    }
    const occupied = member.paneId;
    const fresh = await deps.herdr.paneSplit(occupied, { direction: "down", cwd, env });
    member.paneId = fresh;
    try {
      await saveRoom(deps.env, room);
    } catch (error) {
      // Keep room.json and the panes in agreement: undo the move.
      member.paneId = occupied;
      await deps.herdr.paneClose(fresh).catch(() => undefined);
      throw error;
    }
    deps.out(`${name}: pane ${occupied} is occupied; using ${fresh}`);
    return await start();
  }
}

// ---------------------------------------------------------------- down

/**
 * Close the room's workspace (ending its agents) and archive the room data
 * under rooms/.archive/. Only the human may do this: it is refused from any
 * pane of the room itself.
 */
export async function down(deps: Deps, name: string, force: boolean): Promise<string> {
  const room = await loadRoom(deps.env, name);
  if (!room) throw new SplError(`Room "${name}" does not exist`);
  const pane = deps.env.HERDR_PANE_ID;
  if (pane && Object.values(room.members).some((m) => m.paneId === pane)) {
    throw new SplError(`Refusing to close the room from inside room ${name}; run \`slp down ${name}\` from another terminal.`);
  }
  try {
    await deps.herdr.workspaceClose(room.workspaceId);
    deps.out(`workspace ${room.workspaceId} closed`);
  } catch (error) {
    if (!force) {
      throw new SplError(`Could not close workspace ${room.workspaceId}: ${describe(error)}. ` +
        `If it is already gone, run \`slp down ${name} --force\` to archive the room anyway.`);
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
  for (const lock of ["events.lock", "watch.lock"]) await rm(join(target, lock), { recursive: true, force: true });
  deps.out(`room ${name} archived to ${target}`);
  return target;
}

// Windows refuses to rename a directory while another process briefly holds a
// file in it (e.g. a watcher writing watch.json); such holds last milliseconds.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        throw new SplError(`Could not archive ${from}: ${(error as Error).message}. Move it into ${dirname(to)} by hand.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

// ---------------------------------------------------------------- messages

export async function send(deps: Deps, roomFlag: string | undefined, to: string, text: string): Promise<MessageEvent> {
  const self = await member(deps.env, roomFlag, "lead", "send a brief");
  peerOf(self.room, to);
  const event = await appendEvent(deps.env, self.room.name, (events) => ({
    kind: "brief" as const, case: nextCaseId(events), from: self.name, to, text: nonEmpty(text),
  }), self.room);
  await deliver(deps, self.room, event);
  return event;
}

export async function handback(deps: Deps, roomFlag: string | undefined, caseId: string, text: string): Promise<MessageEvent> {
  const self = await member(deps.env, roomFlag, "peer", "send a handback");
  const event = await appendEvent(deps.env, self.room.name, (events) => {
    const view = foldCases(events).get(caseId);
    if (!view) throw new SplError(`Unknown case ${caseId}`);
    // The briefed peer, and any peer the lead replied to on this case (e.g. a reviewer).
    if (!view.messages.some((m) => m.kind !== "handback" && m.to === self.name)) {
      throw new SplError(`Case ${caseId} was not addressed to ${self.name}`);
    }
    return { kind: "handback" as const, case: caseId, from: self.name, to: view.lead, text: nonEmpty(text) };
  }, self.room);
  await deliver(deps, self.room, event);
  return event;
}

/** `close`: accept and close the case; the recipient then owes no handback. */
export async function reply(deps: Deps, roomFlag: string | undefined, caseId: string, to: string, text: string, close = false): Promise<MessageEvent> {
  const self = await member(deps.env, roomFlag, "lead", "reply");
  peerOf(self.room, to);
  const event = await appendEvent(deps.env, self.room.name, (events) => {
    const view = foldCases(events).get(caseId);
    if (!view) throw new SplError(`Unknown case ${caseId}`);
    if (view.lead !== self.name) throw new SplError(`Case ${caseId} belongs to ${view.lead}`);
    return { kind: "reply" as const, case: caseId, from: self.name, to, text: nonEmpty(text), ...(close ? { closes: true as const } : {}) };
  }, self.room);
  await deliver(deps, self.room, event);
  return event;
}

/**
 * Retry a message. Herdr has no idempotent prompt, so only a delivery Herdr
 * refused is retried by default; a delivered or unconfirmed one (the sender
 * may have crashed after Herdr accepted it) needs `force` after checking.
 */
export async function redeliver(deps: Deps, roomFlag: string | undefined, seq: number, force: boolean): Promise<void> {
  const self = await resolveSelf(deps.env, roomFlag);
  const events = await readEvents(deps.env, self.room.name);
  const event = events.find((e) => e.seq === seq);
  if (!event || !isMessage(event)) throw new SplError(`No message with seq ${seq}`);
  if (event.from !== self.name) throw new SplError(`Message ${seq} was sent by ${event.from}; only its sender can redeliver it`);
  const view = foldCases(events).get(event.case);
  const lastAttempt = events.findLast((e) => e.kind === "delivery" && e.ref === seq);
  if (lastAttempt?.kind === "delivery" && lastAttempt.stage === "relaying" &&
      (deps.now?.() ?? Date.now()) - Date.parse(lastAttempt.ts) < RELAY_GRACE_MS) {
    throw new SplError(`Message ${seq} is being relayed by the room watcher right now; check ${event.to}'s pane in a minute.`);
  }
  if (view?.queued.includes(seq)) {
    throw new SplError(`Message ${seq} is queued; the room watcher will deliver it (\`slp watch --room ${self.room.name}\` must be running).`);
  }
  if (!force && !view?.failed.includes(seq)) {
    throw new SplError(view?.unconfirmed.includes(seq)
      ? `Message ${seq}'s delivery outcome is unknown; it may already be in ${event.to}'s pane. Check there first, then use \`slp redeliver --force ${seq}\` if it is missing.`
      : `Message ${seq} was already delivered to ${event.to}; use --force to send it again.`);
  }
  await deliver(deps, self.room, event);
}

/**
 * Hand a recorded message to Herdr and record the outcome. If this terminal
 * cannot reach Herdr at all (an agent sandbox, seen live with Codex) and the
 * room watcher is running, the message is queued for the watcher to relay.
 * Otherwise a failure throws with the command to retry.
 */
async function deliver(deps: Deps, room: Room, event: MessageEvent): Promise<void> {
  const target = room.members[event.to];
  if (!target) throw new SplError(`Unknown member ${event.to}`);
  const text = await render(deps, room, event);
  let error: unknown = null;
  try {
    // Pane IDs are also the identity key, and work even if the herdr name was
    // never assigned (e.g. the agent was started by hand after a dialog).
    await handToAgent(deps, target.paneId, text);
  } catch (e) {
    error = e;
  }
  if (error === null) {
    await appendEvent(deps.env, room.name, () => ({ kind: "delivery" as const, ref: event.seq, ok: true, error: null }), room);
    deps.out(`${event.kind} ${event.case} (seq ${event.seq}) delivered to ${event.to}`);
    return;
  }
  const reason = describe(error);
  if (unreachable(error) && await lockHeldByLiveProcess(join(roomDir(deps.env, room.name), "watch.lock"))) {
    await appendEvent(deps.env, room.name, () => ({ kind: "delivery" as const, ref: event.seq, ok: false, error: reason, stage: "queued" as const }), room);
    // Worded as the success it is: agents read raw errors here as failure.
    deps.out(`${event.kind} ${event.case} (seq ${event.seq}) recorded; the room watcher will deliver it within seconds. Nothing else to do.`);
    return;
  }
  await appendEvent(deps.env, room.name, () => ({ kind: "delivery" as const, ref: event.seq, ok: false, error: reason }), room);
  throw new SplError(`${event.kind} ${event.case} was recorded as seq ${event.seq} but NOT delivered to ${event.to}: ${reason}. ` +
    (unreachable(error)
      ? `This terminal cannot reach Herdr (an agent sandbox?). Start \`slp watch --room ${room.name}\` outside the sandbox so it can relay messages, then run \`slp redeliver ${event.seq}\`.`
      : `Fix the cause, then run \`slp redeliver ${event.seq}\`.`));
}

/**
 * Deliver one message queued by a sender that could not reach Herdr. Called
 * by the watcher, which runs where Herdr is reachable. The claim is recorded
 * first, so a relay that stops midway shows as unconfirmed, never as queued.
 */
export async function relay(deps: Deps, room: Room, event: MessageEvent): Promise<boolean> {
  const target = room.members[event.to];
  if (!target) return false;
  const claimed = await appendEvent(deps.env, room.name, (events) => {
    const last = events.findLast((e) => e.kind === "delivery" && e.ref === event.seq);
    if (!last || last.kind !== "delivery" || last.stage !== "queued") throw new NotQueued();
    return { kind: "delivery" as const, ref: event.seq, ok: false, error: "relaying", stage: "relaying" as const };
  }, room).catch((error: unknown) => {
    if (error instanceof NotQueued) return null;
    throw error;
  });
  if (!claimed) return false;
  let error: string | null = null;
  try {
    await handToAgent(deps, target.paneId, await render(deps, room, event));
  } catch (e) {
    error = describe(e);
  }
  await appendEvent(deps.env, room.name, () => ({ kind: "delivery" as const, ref: event.seq, ok: error === null, error }), room);
  deps.out(error === null
    ? `relayed ${event.kind} ${event.case} (seq ${event.seq}) from ${event.from} to ${event.to}`
    : `could not relay ${event.kind} ${event.case} (seq ${event.seq}) to ${event.to}: ${error}`);
  return error === null;
}

class NotQueued extends Error {}

/** A failure to reach Herdr at all, as opposed to Herdr refusing the prompt. */
function unreachable(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "cli_failed";
}

async function render(deps: Deps, room: Room, event: MessageEvent): Promise<string> {
  let body = event.text;
  if (body.length > INLINE_LIMIT) {
    const dir = join(roomDir(deps.env, room.name), "messages");
    // Not recursive: if `slp down` archived the room meanwhile, fail instead of
    // recreating the room directory.
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new RoomGoneError(`Room "${room.name}" no longer exists`);
      if (error.code !== "EEXIST") throw error;
    });
    const file = join(dir, `${event.seq}-${event.kind}-${event.case}.md`);
    await writeFile(file, event.text, "utf8");
    body = `The full message is long; read it from this file before acting:\n${file}`;
  }
  return envelope(event.kind, event.case, event.from, body, event.kind === "reply" && event.closes === true);
}

/** A relay claim younger than this is in flight; an older one was interrupted. */
const RELAY_GRACE_MS = 60_000;

/** Submission checks; mutable only so tests need not wait. */
export const submitCheck = { waitMs: 3_000, pollMs: 250 };

/**
 * Prompt an agent and make sure the text was submitted, not left in its input
 * box. Seen live: Claude Code kept a long prompt as "[Pasted text ...]" and
 * ignored Herdr's Enter. If the agent does not start working and its screen
 * shows unsent pasted text, press Enter once more.
 */
export async function handToAgent(deps: Deps, paneId: string, text: string): Promise<void> {
  await deps.herdr.prompt(paneId, text);
  // Checked after the prompt, whatever the state before it: an agent that was
  // working a moment earlier may have settled just as the text arrived.
  if (await startsWorking(deps, paneId)) return;
  if (!(await holdsUnsentPaste(deps, paneId))) return;
  // Re-check right before pressing: never press Enter into a dialog.
  const status = await deps.herdr.agentStatus(paneId).catch(() => null);
  if (status !== "idle" && status !== "done") return;
  await deps.herdr.sendKeys(paneId, ["enter"]);
  if (!(await startsWorking(deps, paneId))) deps.out(`  warning: ${paneId} may still hold the message unsent in its input box`);
}

/** A "[Pasted text" marker on the input line (the last few screen lines), not in older output. */
async function holdsUnsentPaste(deps: Deps, paneId: string): Promise<boolean> {
  const screen = await deps.herdr.agentRead(paneId).catch(() => "");
  const bottom = screen.split(/\r?\n/).filter((line) => line.trim()).slice(-4);
  return bottom.some((line) => /\[Pasted text/i.test(line));
}

async function startsWorking(deps: Deps, paneId: string): Promise<boolean> {
  const deadline = Date.now() + submitCheck.waitMs;
  for (;;) {
    const status = await deps.herdr.agentStatus(paneId).catch(() => null);
    if (status === "working" || status === "blocked") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, submitCheck.pollMs));
  }
}

// ---------------------------------------------------------------- views

export async function status(deps: Deps, roomFlag: string | undefined): Promise<void> {
  const room = await resolveRoom(deps.env, roomFlag);
  deps.out(`room ${room.name}  workspace ${room.workspaceId}  ${room.cwd}`);
  for (const [name, m] of Object.entries(room.members)) deps.out(`  ${name.padEnd(5)} ${m.role.padEnd(10)} ${m.kind.padEnd(8)} ${m.paneId}`);
  const cases = [...foldCases(await readEvents(deps.env, room.name)).values()];
  if (!cases.length) return deps.out("no cases yet");
  deps.out("");
  for (const c of cases) {
    const last = c.messages.at(-1)!;
    const warn = (c.failed.length ? `  UNDELIVERED seq ${c.failed.join(",")}` : "") +
      (c.queued.length ? `  QUEUED seq ${c.queued.join(",")} (the watcher will deliver)` : "") +
      (c.unconfirmed.length ? `  UNCONFIRMED seq ${c.unconfirmed.join(",")}` : "");
    deps.out(`${c.id.padEnd(5)} ${c.lead} -> ${c.peer.padEnd(4)} ${c.state.padEnd(18)} last ${last.kind} seq ${last.seq} ${last.ts}${warn}`);
  }
}

export async function log(deps: Deps, roomFlag: string | undefined, caseId: string): Promise<void> {
  const room = await resolveRoom(deps.env, roomFlag);
  const view = foldCases(await readEvents(deps.env, room.name)).get(caseId);
  if (!view) throw new SplError(`Unknown case ${caseId}`);
  for (const m of view.messages) {
    const flag = view.failed.includes(m.seq) ? `  (NOT DELIVERED: ${view.errors[m.seq]})` : view.unconfirmed.includes(m.seq) ? "  (DELIVERY UNCONFIRMED)" : "";
    deps.out(`--- seq ${m.seq} ${m.kind} ${m.from} -> ${m.to} ${m.ts}${flag}\n${m.text}\n`);
  }
}

// ---------------------------------------------------------------- helpers

async function member(env: Env, roomFlag: string | undefined, role: Member["role"], action: string): Promise<Self> {
  const self = await resolveSelf(env, roomFlag);
  if (self.member.role !== role) throw new SplError(`Only the ${role} can ${action}; you are ${self.name} (${self.member.role})`);
  return self;
}

function peerOf(room: Room, name: string): void {
  if (!MEMBER_NAME.test(name) || room.members[name]?.role !== "peer") {
    const peers = Object.entries(room.members).filter(([, m]) => m.role === "peer").map(([n]) => n);
    throw new SplError(`"${name}" is not a peer in room ${room.name} (peers: ${peers.join(", ")})`);
  }
}

function nonEmpty(text: string): string {
  if (!text.trim()) throw new SplError("Message text is empty");
  return text;
}

export function describe(error: unknown): string {
  if (error instanceof HerdrError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
