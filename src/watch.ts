import { foldCases } from "./cases.js";
import type { MessageEvent, SplEvent } from "./log.js";
import type { Room } from "./room.js";

export type AgentStatus = "idle" | "done" | "working" | "blocked" | "unknown";

/** What the watcher last saw in a member's pane, and since when (ms epoch). */
export interface Observation {
  status: AgentStatus | "gone";
  /** Herdr's `state_change_seq`; identifies one continuous state episode. */
  stateChangeSeq: number | null;
  since: number;
}

export interface Snapshot {
  room: Room;
  events: readonly SplEvent[];
  observed: Readonly<Record<string, Observation>>;
  now: number;
}

export interface WatchConfig { peerIdleMs: number; blockedMs: number; leadIdleMs: number; undeliveredMs: number }

// ADR 0005.
export const DEFAULT_WATCH: WatchConfig = { peerIdleMs: 3 * 60_000, blockedMs: 3 * 60_000, leadIdleMs: 10 * 60_000, undeliveredMs: 3 * 60_000 };

export type Rule = "peer-idle-without-handback" | "blocked" | "lead-no-disposition" | "undelivered" | "member-gone" | "jev-drift";

export interface Alert { key: string; rule: Rule; case: string | null; member: string | null; text: string }

const READY = new Set<Observation["status"]>(["idle", "done"]);

/** Pure rule evaluation. Returns only alerts whose key has not been recorded yet. */
export function evaluate(s: Snapshot, c: WatchConfig): Alert[] {
  const recorded = new Set(s.events.flatMap((e) => (e.kind === "alert" ? [e.key] : [])));
  const deliveredAt = new Map<number, number>();
  for (const e of s.events) if (e.kind === "delivery" && e.ok && !deliveredAt.has(e.ref)) deliveredAt.set(e.ref, Date.parse(e.ts));
  // How long `member` has been ready (idle/done) since `from`, or -1.
  const readyFor = (member: string, from: number) => {
    const o = s.observed[member];
    return o && READY.has(o.status) ? s.now - Math.max(o.since, from) : -1;
  };

  const alerts: Alert[] = [];
  for (const view of foldCases(s.events).values()) {
    for (const m of view.messages) {
      if (!view.undelivered.includes(m.seq) || s.now - Date.parse(m.ts) <= c.undeliveredMs) continue;
      const error = view.errors[m.seq];
      const what = view.queued.includes(m.seq)
        ? `it is queued for the room watcher but was not relayed. Is \`spl watch --room ${s.room.name}\` running outside any agent sandbox?`
        : error !== undefined
        ? `delivery failed (${error}). ${m.from} can retry with \`spl redeliver ${m.seq}\` once the cause is fixed.`
        : `its delivery outcome is unknown (no confirmation was recorded). Check ${m.to}'s pane; only if it is missing, ${m.from} can run \`spl redeliver --force ${m.seq}\`.`;
      alerts.push({
        key: `undelivered:${m.seq}`, rule: "undelivered", case: view.id, member: m.to,
        text: `${m.kind} ${view.id} from ${m.from} to ${m.to} (seq ${m.seq}): ${what}`,
      });
    }
    // Each peer owes a handback for the latest brief/reply addressed to it
    // until it hands back; several peers can owe on one case.
    const owed = new Map<string, MessageEvent>();
    for (const m of view.messages) {
      if (m.kind === "handback") owed.delete(m.from);
      else if (m.kind === "reply" && m.closes) owed.clear(); // closed: nobody owes
      else owed.set(m.to, m);
    }
    for (const [peer, m] of owed) {
      const delivered = deliveredAt.get(m.seq);
      if (delivered === undefined || readyFor(peer, delivered) <= c.peerIdleMs) continue;
      alerts.push({
        key: `peer-idle:${view.id}:${m.seq}`, rule: "peer-idle-without-handback", case: view.id, member: peer,
        text: `${peer} has been idle for over ${minutes(c.peerIdleMs)} since ${m.kind} ${view.id} (seq ${m.seq}) was delivered, without a handback. Check \`spl log ${view.id}\`.`,
      });
    }
    // The lead owes a disposition for every handback newer than its own last
    // message; each one is its own trigger, keyed by its seq.
    const lastLead = view.messages.findLast((m) => m.kind !== "handback")!;
    for (const pending of view.messages.filter((m) => m.kind === "handback" && m.seq > lastLead.seq)) {
      const handedAt = deliveredAt.get(pending.seq);
      if (handedAt === undefined || readyFor(pending.to, handedAt) <= c.leadIdleMs) continue;
      alerts.push({
        key: `lead-idle:${view.id}:${pending.seq}`, rule: "lead-no-disposition", case: view.id, member: pending.to,
        text: `${pending.to} has been idle for over ${minutes(c.leadIdleMs)} since ${pending.from}'s handback on ${view.id} (seq ${pending.seq}) without replying. A disposition is still pending; check \`spl log ${view.id}\`.`,
      });
    }
  }
  for (const [member, o] of Object.entries(s.observed)) {
    if (o.status === "gone") {
      alerts.push({
        key: `gone:${member}:${o.since}`, rule: "member-gone", case: null, member,
        text: `${member}'s pane ${s.room.members[member]?.paneId} no longer hosts its agent (exited, closed or replaced). Messages to ${member} cannot be delivered.`,
      });
    }
    if (o.status === "blocked" && s.now - o.since > c.blockedMs) {
      alerts.push({
        key: `blocked:${member}:${o.stateChangeSeq ?? `t${o.since}`}`, rule: "blocked", case: null, member,
        text: `${member} has been blocked on an approval or question dialog for over ${minutes(c.blockedMs)}. It needs the human in pane ${s.room.members[member]?.paneId}.`,
      });
    }
  }
  return alerts.filter((a) => !recorded.has(a.key));
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}
