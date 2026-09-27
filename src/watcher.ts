import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { foldCases, type CaseView } from "./cases.js";
import { describe, handToAgent, relay, type Deps } from "./commands.js";
import { decision, type Evaluate, type Evidence } from "./jev.js";
import { appendEvent, readEvents, type SplEvent } from "./log.js";
import { loadRoom, RoomGoneError, roomDir, writeAtomic, type Room } from "./room.js";
import { evaluate, type Alert, type Observation, type WatchConfig } from "./watch.js";

const ObservationSchema = z.object({
  status: z.enum(["idle", "done", "working", "blocked", "unknown", "gone"]),
  stateChangeSeq: z.number().nullable(),
  since: z.number(),
});
const StateSchema = z.record(z.string(), ObservationSchema);
const READY = new Set<Observation["status"]>(["idle", "done"]);

/** Delivery rounds per alert before giving up (each round tries every channel). */
export const MAX_ALERT_ROUNDS = 5;
/** Jev requests per pass, so one pass stays short (each may take up to 15 s). */
export const MAX_ASSESSMENTS_PER_PASS = 3;

type AlertEvent = Extract<SplEvent, { kind: "alert" }>;
type AssessmentEvent = Extract<SplEvent, { kind: "assessment" }>;

export interface JevOptions { mode: "off" | "shadow" | "alert"; evaluate: Evaluate; threshold: number }

/**
 * One watcher pass: observe Herdr, persist observations (so durations survive
 * restarts and `--once` runs), record new alerts, deliver every alert no
 * channel has delivered yet, and only then spend time on Jev. Recording before
 * delivering means a crash or a Herdr outage delays an alert instead of losing it.
 */
export async function watchTick(deps: Deps, room: Room, config: WatchConfig, jev?: JevOptions): Promise<AlertEvent[]> {
  const current = await loadRoom(deps.env, room.name);
  if (!current) throw new RoomGoneError(`Room "${room.name}" does not exist (it may have been archived by \`spl down\`)`);
  if (current.workspaceId !== room.workspaceId || current.createdAt !== room.createdAt) {
    throw new RoomGoneError(`Room "${room.name}" was replaced by a newer room with the same name`);
  }
  // Deliver messages that senders inside agent sandboxes could only queue.
  for (const view of foldCases(await readEvents(deps.env, room.name)).values()) {
    for (const seq of view.queued) await relay(deps, room, view.messages.find((m) => m.seq === seq)!);
  }
  const now = deps.now?.() ?? Date.now();
  const observed = await observe(deps, room, now);

  const raised: AlertEvent[] = [];
  for (const alert of evaluate({ room, events: await readEvents(deps.env, room.name), observed, now }, config)) {
    const event = await recordAlert(deps, room, alert,
      (current) => evaluate({ room, events: current, observed, now }, config).some((a) => a.key === alert.key));
    if (event) raised.push(event);
  }
  await deliverPending(deps, room);

  if (jev && jev.mode !== "off") {
    raised.push(...await assess(deps, room, config, jev, now));
    await deliverPending(deps, room);
  }
  return raised;
}

class Duplicate extends Error {}

/**
 * Append an alert unless its key is already recorded or `stillValid` rejects
 * the current log (both checked under the log lock).
 */
async function recordAlert(deps: Deps, room: Room, alert: Alert, stillValid?: (events: SplEvent[]) => boolean): Promise<AlertEvent | null> {
  const event = await appendEvent(deps.env, room.name, (events) => {
    if (events.some((e) => e.kind === "alert" && e.key === alert.key)) throw new Duplicate();
    if (stillValid && !stillValid(events)) throw new Duplicate();
    return { kind: "alert" as const, ...alert };
  }, room).catch((error: unknown) => {
    if (error instanceof Duplicate) return null;
    throw error;
  });
  if (event) deps.out(`alert ${alert.rule}${alert.case ? ` ${alert.case}` : ""}: ${alert.text}`);
  return event;
}

async function deliverPending(deps: Deps, room: Room): Promise<void> {
  const events = await readEvents(deps.env, room.name);
  for (const alert of events.filter((e): e is AlertEvent => e.kind === "alert")) {
    const attempts = events.filter((e) => e.kind === "delivery" && e.ref === alert.seq);
    const rounds = attempts.filter((e) => e.kind === "delivery" && e.channel === "notification").length;
    if (attempts.some((e) => e.kind === "delivery" && e.ok) || rounds >= MAX_ALERT_ROUNDS) continue;
    await deliverAlert(deps, room, alert);
  }
}

/**
 * Ask Jev about cases whose communication changed since their last
 * assessment, once a handback exists. Each state (case, last message seq) is
 * assessed at most once, failed requests included: no retries (ADR 0005). In
 * alert mode a recorded drift for a case's current state always has an alert,
 * including one recorded in shadow mode or before a crash.
 */
async function assess(deps: Deps, room: Room, config: WatchConfig, jev: JevOptions, now: number): Promise<AlertEvent[]> {
  const events = await readEvents(deps.env, room.name);
  const assessed = new Map<string, AssessmentEvent>();
  for (const e of events) if (e.kind === "assessment") assessed.set(`${e.case}:${e.upTo}`, e);
  const raised: AlertEvent[] = [];
  let budget = MAX_ASSESSMENTS_PER_PASS;
  // Oldest current state first, so cases that change often cannot starve
  // the others under the per-pass budget.
  const views = [...foldCases(events).values()].sort((a, b) => a.messages.at(-1)!.seq - b.messages.at(-1)!.seq);
  for (const view of views) {
    const upTo = view.messages.at(-1)!.seq;
    const evidence = caseEvidence(view, now, config);
    if (!evidence) continue;
    let assessment = assessed.get(`${view.id}:${upTo}`) ?? null;
    if (!assessment) {
      if (budget-- <= 0) continue;
      const answers = await jev.evaluate(evidence, new AbortController().signal).catch(() => null);
      const verdict = decision(answers, evidence, jev.threshold);
      const summary = answers && Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, { choice: a.choice, confidence: a.confidence }]));
      // Under the lock: a concurrent watcher may have assessed this state already.
      assessment = await appendEvent(deps.env, room.name, (current) => {
        if (current.some((e) => e.kind === "assessment" && e.case === view.id && e.upTo === upTo)) throw new Duplicate();
        return { kind: "assessment" as const, case: view.id, upTo, mode: jev.mode === "alert" ? "alert" as const : "shadow" as const, verdict, answers: summary };
      }, room).catch((error: unknown) => {
        if (error instanceof Duplicate) return null;
        throw error;
      });
      if (!assessment) continue;
      deps.out(`assessed ${view.id} up to seq ${upTo}: ${verdict}`);
    }
    if (jev.mode !== "alert" || assessment.verdict !== "drift" || !assessment.answers) continue;
    const judged = Object.entries(assessment.answers).map(([k, a]) => `${k}: ${a.choice} ${a.confidence.toFixed(2)}`).join(", ");
    const alert = await recordAlert(deps, room, {
      key: `jev:${view.id}:${upTo}`, rule: "jev-drift", case: view.id, member: null,
      text: `Jev judged the communication on ${view.id} (up to seq ${upTo}) as protocol drift (${judged}). ` +
        `This is a model judgment, not proof; review \`spl log ${view.id}\`.`,
    }, (current) => foldCases(current).get(view.id)?.messages.at(-1)?.seq === upTo);
    if (alert) raised.push(alert);
  }
  return raised;
}

/** Evidence for the latest handback of a case, or null before any handback. */
export function caseEvidence(view: CaseView, now: number, config: WatchConfig): Evidence | null {
  const handback = view.messages.findLast((m) => m.kind === "handback");
  if (!handback) return null;
  const brief = view.messages.findLast((m) => m.kind !== "handback" && m.to === handback.from && m.seq < handback.seq);
  const last = view.messages.at(-1)!;
  return {
    leadId: view.lead,
    peerId: handback.from,
    case: view.id,
    brief: brief?.text ?? "",
    handback: handback.text,
    roomMessages: view.messages.filter((m) => m.kind !== "handback" && m.seq > handback.seq)
      .map((m) => ({ seq: m.seq, from: m.from, to: m.to, text: m.text })),
    uncertainRoomMessages: [],
    pendingDelayElapsed: now - Date.parse(last.ts) > config.leadIdleMs,
    incompleteCommunication: view.undelivered.length > 0,
  };
}

async function observe(deps: Deps, room: Room, now: number): Promise<Record<string, Observation>> {
  const agents = await deps.herdr.agentList();
  const statePath = join(roomDir(deps.env, room.name), "watch.json");
  const previous = await loadState(statePath);
  const observed: Record<string, Observation> = {};
  for (const [name, member] of Object.entries(room.members)) {
    const agent = agents.find((a) => a.paneId === member.paneId);
    // A different kind in the pane means the member was replaced. Without a
    // kind the occupant cannot be attributed: its state is unknown.
    const status = !agent || (agent.kind !== null && agent.kind !== member.kind) ? "gone"
      : agent.kind === null ? "unknown" : toStatus(agent.status);
    const stateChangeSeq = status === "gone" ? null : agent!.stateChangeSeq;
    const prev = previous[name];
    // Same Herdr episode keeps its start time. idle <-> done is only Herdr's
    // "seen" flag flipping, not a new episode.
    const sameEpisode = prev !== undefined && prev.stateChangeSeq === stateChangeSeq &&
      (prev.status === status || (READY.has(prev.status) && READY.has(status)));
    observed[name] = { status, stateChangeSeq, since: sameEpisode ? prev.since : now };
  }
  await writeAtomic(statePath, `${JSON.stringify(observed, null, 2)}\n`);
  return observed;
}

async function deliverAlert(deps: Deps, room: Room, alert: AlertEvent): Promise<void> {
  const record = (channel: "prompt" | "notification", error: string | null) =>
    appendEvent(deps.env, room.name, () => ({ kind: "delivery" as const, ref: alert.seq, ok: error === null, error, channel }), room);
  const supervisor = Object.entries(room.members).find(([, m]) => m.role === "supervisor");
  // A supervisor that is itself blocked or gone cannot take the prompt.
  if (supervisor && supervisor[0] !== alert.member) {
    let error: string | null = null;
    try {
      await handToAgent(deps, supervisor[1].paneId,
        `[SPL alert ${alert.rule}${alert.case ? ` ${alert.case}` : ""}]\n\n${alert.text}\n\n` +
        "[SPL] A fact-based reminder, not a verdict. Review with `spl status` / `spl log` and report concerns to the human.");
    } catch (e) {
      error = describe(e);
      deps.out(`  could not reach the supervisor: ${error}`);
    }
    await record("prompt", error);
  }
  let error: string | null = null;
  try {
    await deps.herdr.notify(`SPL ${room.name}: ${alert.rule}`, alert.text);
  } catch (e) {
    error = describe(e);
    deps.out(`  notification failed: ${error}`);
  }
  await record("notification", error);
}

function toStatus(status: string): Observation["status"] {
  return status === "idle" || status === "done" || status === "working" || status === "blocked" ? status : "unknown";
}

async function loadState(path: string): Promise<Record<string, Observation>> {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
