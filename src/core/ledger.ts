import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GoneError } from "./errors.js";
import { acquireLock, releaseLock } from "./lock.js";
import { projectDir, type Env } from "./paths.js";

// The project ledger: one append-only, locked JSONL file per project. Every
// fact slp keeps (seats, letters, lanes, tasks, reviews, asks, gates,
// incidents) is an event; state is a fold over them (state.ts).

const base = { seq: z.number().int().positive(), ts: z.string() };
const text = z.string();
const list = z.array(z.string());

export const ROLES = ["supervisor", "lead", "peer", "reviewer", "critic"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const LETTER_KINDS = [
  "INTRO", "DIRECTIVE", "TASK", "HANDBACK", "REWORK", "STOP", "ACCEPTED", "REVIEW", "FINDINGS",
  "ASK", "ANSWER", "STILL_OPEN", "REPORT", "MESSAGE", "CRITIQUE", "LANDED", "INCIDENT", "NUDGE", "NOTICE",
] as const;
export const LetterKind = z.enum(LETTER_KINDS);
export type LetterKind = z.infer<typeof LetterKind>;

export const EventSchema = z.discriminatedUnion("kind", [
  // Project settings; the latest one wins.
  z.object({
    kind: z.literal("project"), ...base, base: z.string(), gate: z.string().nullable(),
    gateTimeoutMinutes: z.number().int().positive(), landAs: z.literal("squash"),
  }),
  // A seat opened (or moved to another account); the latest record per name wins.
  z.object({
    kind: z.literal("seat"), ...base, name: z.string(), role: Role, lane: z.string().nullable(), task: z.string().nullable(),
    launcher: z.string(), agent: z.string(), model: z.string().nullable(), effort: z.string().nullable(),
    paneId: z.string(), tabId: z.string(), sessionId: z.string().nullable(), marker: z.string().nullable(),
  }),
  z.object({ kind: z.literal("seat-stop"), ...base, name: z.string(), reason: text }),
  // A message between seats. Recorded first, then delivered through Herdr.
  z.object({
    kind: z.literal("letter"), ...base, letter: LetterKind, from: z.string(), to: z.string(), text,
    lane: z.string().nullable(), task: z.string().nullable(),
  }),
  // One attempt to hand a letter (`ref`) to Herdr, or a hold.
  //  stage "queued": held for the watcher (target busy, or sender cannot reach Herdr);
  //  stage "relaying": the watcher claimed it and is delivering it now.
  z.object({
    kind: z.literal("delivery"), ...base, ref: z.number().int().positive(), ok: z.boolean(), error: z.string().nullable(),
    stage: z.enum(["queued", "relaying"]).optional(), reason: z.enum(["busy", "unreachable"]).optional(),
  }),
  z.object({
    kind: z.literal("lane-open"), ...base, lane: z.string(), title: text, outcome: text, acceptance: list,
    outOfScope: list, writeSet: list, branch: z.string(), workdir: z.string(), inCheckout: z.boolean(),
    base: z.string(), baseCommit: z.string(), humanWords: text,
  }),
  z.object({
    kind: z.literal("lane-amend"), ...base, lane: z.string(), why: text, outcome: text.optional(),
    acceptance: list.optional(), outOfScope: list.optional(), writeSet: list.optional(),
  }),
  z.object({
    kind: z.literal("lane-close"), ...base, lane: z.string(), landed: z.boolean(), reason: text,
    commit: z.string().nullable(), overGate: z.boolean(),
  }),
  z.object({
    kind: z.literal("task-start"), ...base, lane: z.string(), task: z.string(), title: text, goal: text,
    acceptance: list, owned: list, outOfScope: list, context: text, mode: z.enum(["lane", "parallel"]),
    branch: z.string(), workdir: z.string(), baseCommit: z.string(), seat: z.string(),
  }),
  z.object({
    kind: z.literal("task-done"), ...base, task: z.string(), outcome: z.enum(["complete", "partial", "blocked"]),
    summary: text, checks: list, leftUndone: text, head: z.string().nullable(),
  }),
  z.object({ kind: z.literal("task-accept"), ...base, task: z.string(), note: text, merged: z.string().nullable() }),
  z.object({ kind: z.literal("task-rework"), ...base, task: z.string(), note: text }),
  z.object({ kind: z.literal("task-cut"), ...base, task: z.string(), reason: text }),
  z.object({
    kind: z.literal("review-start"), ...base, lane: z.string(), review: z.string(), target: z.string(),
    focus: text, seat: z.string(),
    // The commit the review looks at (a review covers work up to it).
    head: z.string().optional(),
  }),
  z.object({
    kind: z.literal("review-done"), ...base, review: z.string(), summary: text,
    findings: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), where: text, what: text, evidence: text })),
  }),
  z.object({
    kind: z.literal("ask"), ...base, ask: z.string(), from: z.string(), to: z.string(),
    type: z.enum(["need", "blocked", "question"]), text, default: text,
  }),
  z.object({ kind: z.literal("answer"), ...base, ask: z.string(), from: z.string(), text }),
  z.object({ kind: z.literal("report"), ...base, lane: z.string(), type: z.enum(["ready", "progress", "blocked"]), text }),
  z.object({
    kind: z.literal("gate"), ...base, lane: z.string(), command: z.string(), ok: z.boolean(),
    tail: text, durationMs: z.number().int().nonnegative(),
  }),
  // Long work the watcher does for a seat (the seat's own command would time
  // out): run the gate for a ready report, or land a lane. Finished by `done`.
  z.object({
    kind: z.literal("request"), ...base, request: z.string(), what: z.enum(["ready", "land"]), lane: z.string(),
    by: z.string(), note: text, overGate: z.boolean(),
    // Land although slp holds it for risk (the Human agreed; the reason says so).
    overRisk: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("request-done"), ...base, request: z.string(), ok: z.boolean(), detail: text }),
  z.object({
    kind: z.literal("critique"), ...base, lane: z.string(),
    findings: z.array(z.object({ type: z.enum(["missing", "added", "contradiction", "ambiguity"]), text })),
  }),
  // Watch findings (phase 4) and their marks.
  z.object({
    kind: z.literal("incident"), ...base, incident: z.string(), key: z.string(), seat: z.string(), fact: z.string(),
    level: z.enum(["page", "attend", "note"]), text, to: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("ack"), ...base, incident: z.string(), by: z.string(),
    verdict: z.enum(["useful", "noise", "unknown"]), note: text,
  }),
  // Jev (phases 5-6): one recorded decision.
  z.object({
    kind: z.literal("jev"), ...base, point: z.string(), subject: z.string(), mode: z.enum(["shadow", "act"]),
    answers: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number() })).nullable(),
    acted: z.boolean(),
  }),
]);
export type SlpEvent = z.infer<typeof EventSchema>;
export type EventOf<K extends SlpEvent["kind"]> = Extract<SlpEvent, { kind: K }>;
type Draft = SlpEvent extends infer E ? E extends SlpEvent ? Omit<E, "seq" | "ts"> : never : never;

export function ledgerPath(env: Env, project: string): string {
  return join(projectDir(env, project), "ledger.jsonl");
}

export async function readLedger(env: Env, project: string): Promise<SlpEvent[]> {
  return parseEvents(await readRaw(ledgerPath(env, project)));
}

async function readRaw(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseEvents(raw: string): SlpEvent[] {
  const events: SlpEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // A torn line (crash mid-append) is skipped rather than fatal.
    const parsed = EventSchema.safeParse(safeJson(line));
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

function safeJson(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Append one event under the project's lock. `build` sees the current events,
 * so validation and numbering are race-free across the many seats writing to
 * one project. Never creates the project directory.
 */
export async function append<E extends Draft>(
  env: Env, project: string, build: (events: SlpEvent[]) => E,
): Promise<EventOf<E["kind"]>> {
  const dir = projectDir(env, project);
  const gone = () => new GoneError(`Project ${project} does not exist`);
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw gone();
  const lock = join(dir, "ledger.lock");
  const token = await acquireLock(lock).catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === "ENOENT" ? gone() : error;
  });
  try {
    const path = ledgerPath(env, project);
    const raw = await readRaw(path);
    const events = parseEvents(raw);
    const draft = build(events);
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    const event = EventSchema.parse({ ...draft, seq, ts: new Date().toISOString() });
    // Terminate a torn tail so it cannot swallow this event.
    const separator = raw && !raw.endsWith("\n") ? "\n" : "";
    await appendFile(path, `${separator}${JSON.stringify(event)}\n`, "utf8");
    return event as EventOf<E["kind"]>;
  } finally {
    await releaseLock(lock, token);
  }
}

/** Next id with a prefix, counting existing events of one kind (e.g. L3, A12). */
export function nextId(events: readonly SlpEvent[], kind: SlpEvent["kind"], prefix: string): string {
  return `${prefix}${events.filter((e) => e.kind === kind).length + 1}`;
}
