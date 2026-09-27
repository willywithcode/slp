import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Env } from "../core/paths.js";

// Transcript readers (ADR 0009). Formats are not public contracts: each
// reader is isolated, tested on recorded samples, and yields fewer steps
// rather than wrong ones when a line is not understood.

export type StepKind = "user" | "say" | "command" | "edit" | "result" | "error";

export interface Step {
  at: string;
  kind: StepKind;
  /** Command line, message text, error text, or tool output. */
  text: string;
  /** Edits: files touched (as written in the transcript). */
  files?: string[];
  /** Edits: lines removed and added. */
  removed?: string[];
  added?: string[];
  /** Results: true when the tool reported a failure, null when unknown. */
  failed?: boolean | null;
  /** Pairs a tool call with its result (Claude tool_use id, Codex call_id). */
  ref?: string;
}

// ---------------------------------------------------------------- Claude Code

type Json = Record<string, any>;

function lines(text: unknown): string[] {
  return typeof text === "string" && text ? text.split(/\r?\n/) : [];
}

function ref(id: unknown): { ref?: string } {
  return typeof id === "string" && id ? { ref: id } : {};
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Json) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n");
}

/** Steps from one line of a Claude Code transcript (`<session-id>.jsonl`). */
export function claudeSteps(line: Json): Step[] {
  const at = typeof line.timestamp === "string" ? line.timestamp : "";
  const content = line.message?.content;
  if (line.type === "assistant" && line.isApiErrorMessage) return [{ at, kind: "error", text: textOf(content) }];
  if (line.type === "user") {
    if (typeof content === "string") return [{ at, kind: "user", text: content }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((b: Json): Step[] => {
      if (b?.type === "tool_result") return [{ at, kind: "result", text: textOf(b.content), failed: b.is_error === true ? true : b.is_error === false ? false : null, ...ref(b.tool_use_id) }];
      if (b?.type === "text" && typeof b.text === "string") return [{ at, kind: "user", text: b.text }];
      return [];
    });
  }
  if (line.type !== "assistant" || !Array.isArray(content)) return [];
  return content.flatMap((b: Json): Step[] => {
    if (b?.type === "text" && typeof b.text === "string") return [{ at, kind: "say", text: b.text }];
    if (b?.type !== "tool_use") return [];
    const input: Json = b.input ?? {};
    const id = ref(b.id);
    if (b.name === "Bash" && typeof input.command === "string") return [{ at, kind: "command", text: input.command, ...id }];
    if ((b.name === "Edit" || b.name === "Write" || b.name === "NotebookEdit") && typeof input.file_path === "string") {
      return [{ at, kind: "edit", text: `${b.name} ${input.file_path}`, files: [input.file_path],
        removed: lines(input.old_string), added: lines(input.new_string ?? input.content ?? input.new_source), ...id }];
    }
    if (b.name === "MultiEdit" && typeof input.file_path === "string" && Array.isArray(input.edits)) {
      return [{ at, kind: "edit", text: `MultiEdit ${input.file_path}`, files: [input.file_path],
        removed: input.edits.flatMap((e: Json) => lines(e.old_string)), added: input.edits.flatMap((e: Json) => lines(e.new_string)), ...id }];
    }
    return [];
  });
}

// ---------------------------------------------------------------------- Codex

/** Unquote a JS/JSON string literal body; null when it is not one. */
function unquote(body: string): string | null {
  try { return JSON.parse(`"${body}"`) as string; } catch { return null; }
}

/** Files and changed lines of an apply_patch body. */
export function parsePatch(patch: string): { files: string[]; removed: string[]; added: string[] } {
  const files: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const l of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(l)?.[1];
    if (file) files.push(file.trim());
    else if (l.startsWith("+") && !l.startsWith("+++")) added.push(l.slice(1));
    else if (l.startsWith("-") && !l.startsWith("---")) removed.push(l.slice(1));
  }
  return { files, removed, added };
}

/** One apply_patch body, file by file. */
export function parsePatchFiles(patch: string): { file: string; removed: string[]; added: string[] }[] {
  const out: { file: string; removed: string[]; added: string[] }[] = [];
  for (const l of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(l)?.[1];
    if (file) out.push({ file: file.trim(), removed: [], added: [] });
    else if (!out.length) continue;
    else if (l.startsWith("+") && !l.startsWith("+++")) out.at(-1)!.added.push(l.slice(1));
    else if (l.startsWith("-") && !l.startsWith("---")) out.at(-1)!.removed.push(l.slice(1));
  }
  return out;
}

/** Commands and patches inside one Codex tool call (code-mode `exec`, or the older shell/apply_patch calls). */
function codexCall(name: string, input: string, at: string, id: { ref?: string }): Step[] {
  const steps: Step[] = [];
  const patchAt = input.indexOf("*** Begin Patch");
  if (patchAt >= 0) {
    // In code mode the patch sits in a string literal; unescape it first.
    const literal = /"((?:[^"\\]|\\.)*\*\*\* Begin Patch(?:[^"\\]|\\.)*)"/.exec(input)?.[1];
    const patch = (literal !== undefined ? unquote(literal) : null) ?? input.slice(patchAt);
    // One step per file, so each file's lines are judged on their own.
    for (const p of parsePatchFiles(patch)) {
      steps.push({ at, kind: "edit", text: `apply_patch ${p.file}`, files: [p.file], removed: p.removed, added: p.added, ...id });
    }
  }
  if (name === "exec" || name === "exec_command" || name === "shell") {
    for (const m of input.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const cmd = unquote(m[1]!);
      if (cmd !== null) steps.push({ at, kind: "command", text: cmd, ...id });
    }
    if (!steps.some((s) => s.kind === "command")) {
      // Older calls: {"command": ["bash", "-lc", "..."]} or {"cmd": "..."} as JSON arguments.
      try {
        const args = JSON.parse(input) as Json;
        const cmd = Array.isArray(args.command) ? args.command.at(-1) : args.cmd ?? args.command;
        if (typeof cmd === "string") steps.push({ at, kind: "command", text: cmd, ...id });
      } catch { /* not JSON */ }
    }
  }
  return steps;
}

/** Steps from one line of a Codex rollout (`rollout-*.jsonl`). */
export function codexSteps(line: Json): Step[] {
  const at = typeof line.timestamp === "string" ? line.timestamp : "";
  const p: Json = line.payload ?? {};
  if (line.type === "event_msg" && p.type === "error" && typeof p.message === "string") return [{ at, kind: "error", text: p.message }];
  if (line.type !== "response_item") return [];
  if (p.type === "message") {
    const text = textOf(p.content);
    if (p.role === "assistant") return text ? [{ at, kind: "say", text }] : [];
    if (p.role === "user" && text && !text.startsWith("<environment_context>")) return [{ at, kind: "user", text }];
    return [];
  }
  if (p.type === "custom_tool_call" || p.type === "function_call") {
    const input = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
    return codexCall(String(p.name ?? ""), input, at, ref(p.call_id));
  }
  if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
    const out = typeof p.output === "string" ? p.output : textOf(p.output);
    const code = /(?:exit code|exited with code|Process exited with code)[:\s]+(-?\d+)/i.exec(out)?.[1];
    return [{ at, kind: "result", text: out, failed: code === undefined ? null : code !== "0", ...ref(p.call_id) }];
  }
  return [];
}

// -------------------------------------------------------------------- finding

export function claudeHome(env: Env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** A Claude Code transcript by session id, in any project folder. */
export async function findClaudeTranscript(env: Env, sessionId: string): Promise<string | null> {
  const root = join(claudeHome(env), "projects");
  const dirs = await readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    const path = join(root, d, `${sessionId}.jsonl`);
    if (await stat(path).then((s) => s.isFile(), () => false)) return path;
  }
  return null;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } finally {
    await handle.close();
  }
}

/**
 * The Codex rollout whose session lists `marker` among its workspace roots
 * (slp gives each Codex seat its own marker directory), searched in the
 * given Codex homes for rollouts started on or after `since`.
 */
export async function findCodexRollout(homes: readonly string[], marker: string, since: Date): Promise<string | null> {
  const days = new Set<string>();
  for (let t = since.getTime() - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    days.add(join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
  }
  for (const home of homes) {
    for (const day of days) {
      const dir = join(home, "sessions", day);
      const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
      for (const f of files) {
        const path = join(dir, f);
        const info = await stat(path).catch(() => null);
        if (!info || info.mtimeMs < since.getTime() - 60_000) continue;
        try {
          const meta = JSON.parse(await firstLine(path)) as Json;
          const roots: unknown = meta.payload?.runtime_workspace_roots ?? meta.payload?.workspace_roots;
          if (Array.isArray(roots) && roots.some((r) => typeof r === "string" && samePath(r, marker))) return path;
        } catch { /* not a rollout we understand */ }
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------- reading

/** Reads a transcript incrementally: each call returns the steps added since the last. */
export class TranscriptTail {
  private offset = 0;
  /** Bytes after the last newline read so far (a line still being written). */
  private partial: Buffer = Buffer.alloc(0);

  constructor(readonly path: string, private readonly parse: (line: Json) => Step[]) {}

  /** Everything up to the current end, however large (next() reads at most 32 MiB at a time). */
  async all(): Promise<Step[]> {
    const steps: Step[] = [];
    for (;;) {
      const before = this.offset;
      steps.push(...await this.next());
      if (this.offset === before) return steps;
    }
  }

  async next(): Promise<Step[]> {
    const info = await stat(this.path).catch(() => null);
    if (!info) return [];
    if (info.size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); } // rewritten
    if (info.size === this.offset) return [];
    const handle = await open(this.path, "r");
    let bytes: Buffer;
    try {
      const length = Math.min(info.size - this.offset, 32 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      bytes = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
    } finally {
      await handle.close();
    }
    // Split on the newline byte, which never occurs inside a multi-byte character.
    const end = bytes.lastIndexOf(0x0a);
    this.partial = bytes.subarray(end + 1);
    const parts = end < 0 ? [] : bytes.subarray(0, end).toString("utf8").split("\n");
    const steps: Step[] = [];
    for (const raw of parts) {
      if (!raw.trim()) continue;
      try { steps.push(...this.parse(JSON.parse(raw) as Json)); } catch { /* torn or foreign line */ }
    }
    return steps;
  }
}

/** The session id a Codex rollout belongs to (what `codex resume` takes). */
export async function codexSessionId(path: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await firstLine(path)) as Json;
    const id: unknown = meta.payload?.id ?? meta.payload?.session_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * What the Human typed to the Supervisor since `since`: its own messages in
 * the Supervisor's transcript, not letters or tool output. The Critic reads
 * these rather than the Supervisor's summary of them.
 */
export async function humanWordsSince(env: Env, sessionId: string, since: string): Promise<string[]> {
  const path = await findClaudeTranscript(env, sessionId);
  if (!path) return [];
  const steps = await new TranscriptTail(path, (line) => (line.isMeta ? [] : claudeSteps(line))).all();
  const from = Date.parse(since);
  return steps
    .filter((s) => s.kind === "user" && Date.parse(s.at) >= from)
    .map((s) => s.text.trim())
    .filter((t) => t && !t.startsWith("[SLP") && !t.startsWith("<") && !/^\[Request interrupted/.test(t));
}
