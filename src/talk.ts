import { SlpError } from "./core/errors.js";
import { append, nextId, readLedger } from "./core/ledger.js";
import { dirtyPaths } from "./git.js";
import { sendLetter } from "./letters.js";
import { leadOf, superiorOf } from "./state.js";
import { laneOf, type Actor } from "./tasks.js";

// Messages, asks, reports and critiques: everything a seat says that is not a
// task or review step. All of it goes through letters (ADR 0012).

export async function message(a: Actor, to: string, text: string): Promise<void> {
  if (!text.trim()) throw new SlpError("Empty message.");
  const target = a.state.seats.get(to);
  if (!target?.live) throw new SlpError(`No live seat "${to}". \`slp status\` lists the team.`);
  if (to === a.seat.name) throw new SlpError("That is you.");
  if (a.seat.role === "lead") {
    const mine = target.lane === a.seat.lane || target.role === "supervisor";
    if (!mine) throw new SlpError(`${to} is not in your lane; go through the Supervisor.`);
  }
  await sendLetter(a.deps, a.project.id, { letter: "MESSAGE", from: a.seat.name, to, lane: target.lane, task: target.task, text });
  // The Supervisor never goes around a Lead: its Lead gets a copy.
  if (a.seat.role === "supervisor" && target.lane && target.role !== "lead") {
    const lead = leadOf(a.state, target.lane);
    if (lead) {
      await sendLetter(a.deps, a.project.id, { letter: "NOTICE", from: "slp", to: lead.name, lane: target.lane, task: target.task,
        text: `Copy: the Supervisor wrote to ${to}:\n\n${text}` });
    }
  }
}

export async function ask(a: Actor, type: "need" | "blocked" | "question", text: string, fallback: string): Promise<void> {
  if (!text.trim()) throw new SlpError("Empty ask.");
  const superior = superiorOf(a.state, a.seat);
  const to = superior && a.state.seats.get(superior)?.live ? superior : "human";
  const event = await append(a.deps.env, a.project.id, (events) => ({
    kind: "ask" as const, ask: nextId(events, "ask", "A"), from: a.seat.name, to, type, text, default: fallback,
  }));
  await sendLetter(a.deps, a.project.id, { letter: "ASK", from: a.seat.name, to, lane: a.seat.lane, task: a.seat.task,
    text: `${event.ask} (${type}): ${text}${fallback.trim() ? `\n\nMeanwhile ${a.seat.name} will: ${fallback}` : ""}` });
  a.deps.out(`${event.ask} sent to ${to}. ${fallback.trim() ? "Carry on with your default meanwhile." : "Wait for the ANSWER letter."}`);
}

export async function answer(a: Actor, id: string, text: string): Promise<void> {
  const question = a.state.asks.get(id);
  if (!question) throw new SlpError(`No ask ${id}`);
  if (question.answer !== null) throw new SlpError(`${id} is already answered.`);
  if (question.to !== a.seat.name && a.seat.role !== "supervisor") throw new SlpError(`${id} was asked of ${question.to}, not you.`);
  if (!text.trim()) throw new SlpError("Empty answer.");
  await append(a.deps.env, a.project.id, () => ({ kind: "answer" as const, ask: id, from: a.seat.name, text }));
  if (a.state.seats.get(question.from)?.live) {
    const asker = a.state.seats.get(question.from)!;
    await sendLetter(a.deps, a.project.id, { letter: "ANSWER", from: a.seat.name, to: question.from, lane: asker.lane, task: asker.task,
      text: `${id}: ${question.text}\n\n${text}` });
  } else {
    a.deps.out(`${id} answered; ${question.from} is closed, so nobody was told.`);
  }
}

export async function report(a: Actor, type: "ready" | "progress" | "blocked", text: string): Promise<void> {
  const lane = laneOf(a);
  if (!text.trim()) throw new SlpError(type === "ready" ? "Say how each acceptance item is met." : "Empty report.");
  if (type === "ready") {
    const open = [...a.state.tasks.values()].filter((t) => t.lane === lane.id && ["running", "handed-back", "rework"].includes(t.state));
    if (open.length) throw new SlpError(`Not ready: ${open.map((t) => `${t.id} is ${t.state}`).join(", ")}. Accept or cut them first.`);
    const dirty = await dirtyPaths(lane.workdir);
    if (dirty.length) throw new SlpError(`Not ready: uncommitted changes in ${lane.workdir} (${dirty.slice(0, 10).join(", ")}).`);
  }
  await append(a.deps.env, a.project.id, () => ({ kind: "report" as const, lane: lane.id, type, text }));
  if (type !== "ready") {
    await sendLetter(a.deps, a.project.id, { letter: "REPORT", from: a.seat.name, to: "sup", lane: lane.id, text: `${type}: ${text}` });
    return;
  }
  const events = await readLedger(a.deps.env, a.project.id);
  const done = new Set(events.flatMap((e) => (e.kind === "request-done" ? [e.request] : [])));
  if (events.some((e) => e.kind === "request" && e.lane === lane.id && !done.has(e.request))) {
    throw new SlpError(`Lane ${lane.id} already has a gate or landing in progress; its result comes as a letter.`);
  }
  const req = await append(a.deps.env, a.project.id, (evs) => ({
    kind: "request" as const, request: nextId(evs, "request", "Q"), what: "ready" as const, lane: lane.id, by: a.seat.name, note: text, overGate: false,
  }));
  a.deps.out(`Ready report recorded (${req.request}). The watcher runs the gate now and sends the result with your report to the Supervisor.`);
}

export type CritiqueType = "missing" | "added" | "contradiction" | "ambiguity";

export function parseCritique(raw: string): { type: CritiqueType; text: string } {
  const at = raw.indexOf("::");
  const type = raw.slice(0, at).trim().toLowerCase();
  const text = raw.slice(at + 2).trim();
  if (at < 0 || !["missing", "added", "contradiction", "ambiguity"].includes(type) || !text) {
    throw new SlpError(`A finding is "missing|added|contradiction|ambiguity :: text", got: ${raw}`);
  }
  return { type: type as CritiqueType, text };
}

export async function findings(a: Actor, list: { type: CritiqueType; text: string }[]): Promise<void> {
  const lane = a.seat.lane;
  if (!lane) throw new SlpError(`${a.seat.name} has no lane.`);
  if (a.state.letters.some((l) => l.from === a.seat.name && l.letter === "CRITIQUE")) throw new SlpError("You already reported.");
  if (list.length > 5) throw new SlpError("At most five findings, most important first.");
  await append(a.deps.env, a.project.id, () => ({ kind: "critique" as const, lane, findings: list }));
  await sendLetter(a.deps, a.project.id, { letter: "CRITIQUE", from: a.seat.name, to: "sup", lane, text: list.length
    ? list.map((f, i) => `${i + 1}. ${f.type}: ${f.text}`).join("\n")
    : `No gaps found between lane ${lane} and the Human's words.` });
  a.deps.out("Findings sent to the Supervisor. You are done; this seat closes shortly.");
}
