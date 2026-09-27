import { z } from "zod";
import type { Env } from "../core/paths.js";

// Jev (ADR 0009, 0013): typed questions over a shared state, answered with
// calibrated probabilities. Optional: no key, no Jev, and every decision
// point falls back to code. Reached through TypeSafe or OpenRouter. No
// retries; errors, timeouts and malformed answers are all "no answer". Keys,
// states and answers are never logged.

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const PINNED = /^jev-\d+\.\d+\.\d+$/;

/** A question with one answer from a fixed set of labels (yes/no, a choice, or an ordered scale). */
export interface Question {
  instructions: string;
  /** Label → what it means. Every question has an "unsure" (or "none") label. */
  criteria: Record<string, string>;
}

export interface Answer { choice: string; confidence: number; probabilities: Record<string, number> }
export type Answers = Record<string, Answer>;

export interface Jev {
  provider: "typesafe" | "openrouter";
  model: string;
  ask(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Answers | null>;
}

const probability = z.number().min(0).max(1);

/** Validate one answer against its question's labels: a known choice that is the single most likely one. */
export function validAnswer(raw: unknown, labels: readonly string[]): Answer | null {
  const parsed = z.object({ choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }).safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (!labels.includes(a.choice) || Object.keys(a.probabilities).some((k) => !labels.includes(k))) return null;
  const values = Object.values(a.probabilities);
  const selected = a.probabilities[a.choice];
  if (selected === undefined || Math.abs(values.reduce((s, n) => s + n, 0) - 1) > 0.01) return null;
  if (values.filter((n) => n >= selected).length !== 1) return null;
  return a;
}

export function parseAnswers(raw: unknown, questions: Record<string, Question>): Answers | null {
  const answers = (raw as { answers?: Record<string, unknown> } | null)?.answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = validAnswer(answers[name], Object.keys(q.criteria));
    if (!a) return null;
    out[name] = a;
  }
  return out;
}

/** Jev from the environment, or null when no key is set. */
export function jevFromEnv(env: Env, http: typeof fetch = fetch, timeoutMs = 15_000): Jev | null {
  const typesafe = env.JEV_API_KEY?.trim();
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  if (!typesafe && !openrouter) return null;
  const provider = typesafe ? "typesafe" as const : "openrouter" as const;
  const model = env.JEV_MODEL?.trim() || (provider === "typesafe" ? "jev-1.13.0" : "typesafe/jev-1.13");
  if (provider === "typesafe" && !PINNED.test(model)) throw new Error("JEV_MODEL must be a pinned version such as jev-1.13.0");
  const endpoint = provider === "typesafe" ? TYPESAFE_ENDPOINT : OPENROUTER_ENDPOINT;
  const key = (typesafe ?? openrouter)!;
  return {
    provider, model,
    async ask(state, questions, signal) {
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        const body = { model, state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "choice", ...q }])) };
        const res = await http(endpoint, {
          method: "POST", redirect: "error", signal: combined,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const raw: unknown = await res.json();
        return combined.aborted ? null : parseAnswers(raw, questions);
      } catch {
        return null;
      }
    },
  };
}
