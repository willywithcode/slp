import type { Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append } from "./core/ledger.js";
import { sendLetter, showsStartupDialog } from "./letters.js";
import { leadOf } from "./state.js";
import type { Actor } from "./tasks.js";

// Permission prompts (ADR 0016, after seatworks' `permit`): while the Human
// is out of the loop, the Supervisor answers a seat's permission prompt for
// them; the answer is recorded and a Peer's Lead is told. Startup dialogs
// (folder trust) are never answered by anyone but the Human.

/** Claude Code's and Codex's permission prompts, as seen on screen. */
const CLAUDE_PROMPT = /Do you want to (proceed|make this edit|create|overwrite|allow)/i;
const CODEX_PROMPT = /Would you like to (run the following command|make the following edits|apply|allow)/i;

export type PromptKind = "claude" | "codex";

export function permissionPrompt(screen: string): { kind: PromptKind; excerpt: string } | null {
  const lines = screen.split(/\r?\n/).filter((l) => l.trim()).slice(-25);
  const bottom = lines.join("\n");
  const kind: PromptKind | null = CLAUDE_PROMPT.test(bottom) ? "claude" : CODEX_PROMPT.test(bottom) ? "codex" : null;
  if (!kind) return null;
  const start = lines.findIndex((l) => /Bash command|Edit file|Write|Create file|Would you like|\$ /.test(l));
  const excerpt = lines.slice(Math.max(0, start), start + 8).map((l) => l.replace(/[│╭╰─]+/g, "").trim()).filter(Boolean).join("\n");
  return { kind, excerpt: excerpt.slice(0, 600) };
}

/**
 * A Yes/No choice waiting at the bottom of a screen that is not a
 * permission prompt slp knows (ADR 0020): a numbered menu with a selected
 * "Yes" and a "No", or a trailing (y/n). Returns its excerpt.
 */
export function choicePrompt(screen: string): string | null {
  const lines = screen.split(/\r?\n/).filter((l) => l.trim()).slice(-12);
  const bottom = lines.join("\n");
  const menu = /^\s*[❯›>]\s*1\.\s*Yes\b/im.test(bottom) && /^\s*[❯›>]?\s*\d\.\s*No\b/im.test(bottom);
  const yn = /(\(y\/n\)|\[y\/n\])\s*:?\s*$/i.test(lines.at(-1) ?? "");
  if (!menu && !yn) return null;
  return lines.slice(-8).map((l) => l.replace(/[│╭╰╮╯─]+/g, "").trim()).filter(Boolean).join("\n").slice(0, 600);
}

/** What a seat is being asked to allow, for the notice to whoever answers. */
export async function pendingPrompt(deps: Deps, paneId: string): Promise<string | null> {
  const screen = await deps.herdr.agentRead(paneId).catch(() => "");
  return permissionPrompt(screen)?.excerpt ?? null;
}

export async function permit(a: Actor, config: Config, name: string, allow: boolean, why: string): Promise<void> {
  if (config.human.inLoop) throw new SlpError("The Human is in the loop: seats' permissions are theirs to answer. (Config: \"human\": { \"inLoop\": false } hands them to you.)");
  if (!why.trim()) throw new SlpError("Say why: it is recorded, and a refused seat reads it.");
  const seat = a.state.seats.get(name);
  if (!seat?.live) throw new SlpError(`No live seat "${name}"`);
  if (seat.name === a.seat.name) throw new SlpError("Your own prompts are the Human's.");
  // One read, judged and answered at once: the key goes to exactly the screen that was checked.
  const screen = await a.deps.herdr.agentRead(seat.paneId).catch(() => null);
  if (screen === null) throw new SlpError(`Cannot read ${name}'s screen; nothing was pressed.`);
  if (showsStartupDialog(screen)) throw new SlpError(`${name} shows a startup dialog (folder trust): only the Human answers that.`);
  const prompt = permissionPrompt(screen);
  if (!prompt) throw new SlpError(`${name} is not showing a permission prompt; nothing was pressed.`);
  // Claude Code highlights "1. Yes" (Enter takes it); Codex takes "y"; Esc refuses in both.
  const keys = !allow ? ["esc"] : prompt.kind === "codex" ? ["y"] : ["enter"];
  if (allow && prompt.kind === "claude" && !/❯\s*1\.\s*Yes/.test(screen)) throw new SlpError(`${name}'s prompt has not got "Yes" selected; nothing was pressed. The Human should look.`);
  await a.deps.herdr.sendKeys(seat.paneId, keys);
  await append(a.deps.env, a.project.id, () => ({
    kind: "permit" as const, seat: name, allow, why, by: a.seat.name, prompt: prompt.excerpt,
  }));
  if (!allow) {
    await sendLetter(a.deps, a.project.id, { letter: "NOTICE", from: a.seat.name, to: name, lane: seat.lane, task: seat.task,
      text: `Your request was refused:\n${prompt.excerpt}\n\nWhy: ${why}\nFind another way within your brief, or \`slp ask\`.` }).catch(() => undefined);
  }
  const lead = seat.role === "peer" && seat.lane ? leadOf(a.state, seat.lane) : null;
  if (lead) {
    await sendLetter(a.deps, a.project.id, { letter: "NOTICE", from: "slp", to: lead.name, lane: seat.lane, task: seat.task,
      text: `The Supervisor ${allow ? "allowed" : "refused"} ${name}'s request (${why}):\n${prompt.excerpt}` }).catch(() => undefined);
  }
  a.deps.out(`${allow ? "allowed" : "refused"} ${name}'s request`);
}
