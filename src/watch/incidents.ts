import type { Config } from "../core/config.js";
import type { Deps } from "../core/deps.js";
import { append, nextId } from "../core/ledger.js";
import { describe, sendLetter } from "../letters.js";
import { leadOf, type Seat, type State } from "../state.js";
import type { Fact } from "./facts.js";

// The incident book (ADR 0009). Every fact becomes one incident, routed to
// whoever answers for the seat; the watched seat never hears. Mail is off
// (shadow) until the owner turns it on; pages always reach the Human, and
// account problems always reach the Supervisor, who may move the seat
// (ADR 0011).

/** Facts about the seat's account rather than its work. */
const ACCOUNT_FACTS = new Set(["usage_limit", "auth_failed"]);

export function routeFor(state: State, seat: Seat, fact: Fact): string | null {
  const sup = state.seats.get("sup")?.live ? "sup" : null;
  if (fact.level === "page" || ACCOUNT_FACTS.has(fact.fact)) return seat.name === "sup" ? null : sup;
  if (seat.role === "peer" || seat.role === "reviewer") {
    const lead = seat.lane ? leadOf(state, seat.lane) : null;
    return lead?.name ?? sup;
  }
  return seat.name === "sup" ? null : sup;
}

function mailedToday(state: State, to: string, now: number): number {
  return state.letters.filter((l) => l.letter === "INCIDENT" && l.to === to && now - Date.parse(l.ts) < 86_400_000).length;
}

/** Other launchers that run the same agent: where a seat could move. */
export function alternatives(config: Config, seat: Seat): string[] {
  return Object.entries(config.launchers).filter(([name, l]) => l.agent === seat.agent && name !== seat.launcher).map(([name]) => name);
}

/** Record a fact about a seat as an incident (once per key) and route it. Returns the incident id, or null if already known. */
export async function raise(deps: Deps, project: string, state: State, config: Config, seat: Seat, fact: Fact): Promise<string | null> {
  if (state.incidents.some((i) => i.key === fact.key && i.seat === seat.name)) return null;
  const to = routeFor(state, seat, fact);
  let duplicate = false;
  const event = await append(deps.env, project, (events) => {
    duplicate = events.some((e) => e.kind === "incident" && e.key === fact.key && e.seat === seat.name);
    return { kind: "incident" as const, incident: nextId(events, "incident", "I"), key: fact.key, seat: seat.name,
      fact: fact.fact, level: fact.level, text: fact.text, to };
  });
  if (duplicate) return null;
  const id = event.incident;
  const now = deps.now?.() ?? Date.now();
  const tell = async (letter: "INCIDENT" | "NOTICE", target: string, text: string) => {
    await sendLetter(deps, project, { letter, from: "slp", to: target, lane: seat.lane, task: seat.task, text })
      .catch((error: unknown) => deps.out(`could not send ${id} to ${target}: ${describe(error)}`));
  };

  if (ACCOUNT_FACTS.has(fact.fact)) {
    const moves = alternatives(config, seat);
    const hint = moves.length
      ? `If it does not recover, move it: \`slp move-seat ${seat.name} ${moves[0]}\` (also: ${moves.join(", ")}). The session resumes on that account.`
      : "No other account is configured for this agent; tell the Human.";
    await deps.herdr.notify(`slp: ${seat.name} account problem`, fact.text).catch(() => undefined);
    if (to) await tell("NOTICE", to, `${id}: ${seat.name} (${seat.launcher}) ${fact.text}\n\n${hint}`);
    return id;
  }
  if (fact.level === "page") {
    await deps.herdr.notify(`slp: ${seat.name} needs a look`, fact.text).catch(() => undefined);
  }
  if (!config.watch.mail || !to) return id;
  if (mailedToday(state, to, now) >= config.watch.budgetPerDay) {
    deps.out(`${id} recorded; ${to} already had ${config.watch.budgetPerDay} incidents today`);
    return id;
  }
  await tell("INCIDENT", to, `${id} [${fact.level}] ${seat.name} ${fact.text}\n\n` +
    `Check the record before acting (\`slp status\`${seat.task ? `, \`slp diff ${seat.task}\`` : ""}). ` +
    `Then mark it: \`slp ack ${id} useful|noise|unknown ["note"]\`. ${seat.name} was not told.`);
  return id;
}
