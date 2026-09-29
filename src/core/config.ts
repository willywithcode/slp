import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { SlpError } from "./errors.js";
import { writeAtomic } from "./fsutil.js";
import { Role, type Role as RoleName } from "./ledger.js";
import { configPath, type Env } from "./paths.js";

// ADR 0011: launchers (how to open an agent on an account) and, per role,
// which launchers, model and effort to use. slp never reads account secrets;
// a launcher only names environment variables and a pane preparation that the
// seat's own shell runs.

const Agent = z.enum(["claude", "codex", "agy"]);
export type Agent = z.infer<typeof Agent>;

const Launcher = z.object({
  agent: Agent,
  // The command that starts the agent in the seat's shell, with slp's
  // arguments appended: e.g. the owner's own "claude-as acc1" or
  // "codex-as acc2", which pick the account. Absent: Herdr starts the plain
  // agent. Each machine defines its own such commands (README).
  command: z.string().min(1).optional(),
  // Set in the seat's shell before the agent starts; null unsets the variable.
  // "{home}" expands to the user's home directory.
  env: z.record(z.string(), z.string().nullable()).default({}),
  // Extra shell commands, per shell family, run in the seat's pane first.
  prep: z.object({ powershell: z.string().optional(), sh: z.string().optional() }).default({}),
});
export type Launcher = z.infer<typeof Launcher>;

const Preset = z.object({ launcher: z.string().optional(), model: z.string(), effort: z.string().optional() });
export type Preset = z.infer<typeof Preset>;

const RoleConfig = z.object({
  // One launcher, or several used in rotation (e.g. Peers across accounts).
  use: z.array(z.string()).min(1),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  // Named choices a Lead may pick per task (Peers): e.g. sol, luna, flash.
  presets: z.record(z.string(), Preset).default({}),
  defaultPreset: z.string().nullable().default(null),
  // More Claude Code permission rules the role runs without asking (ADR
  // 0016), e.g. "Bash(dotnet build*)"; slp's deny rules still win.
  allow: z.array(z.string()).default([]),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

const ConfigSchema = z.object({
  version: z.literal(1),
  launchers: z.record(z.string(), Launcher),
  roles: z.record(Role, RoleConfig),
  // The watch (ADR 0009): incidents are mailed to seats only once the owner
  // turns mail on; at most budgetPerDay per recipient.
  // Timings: a permission prompt goes to the Supervisor after permitAfterMs
  // (a prompt of a kind slp does not know, to whoever answers, after as
  // long); other prompts reach the Human after blockedMs; the watcher looks
  // every intervalSeconds.
  watch: z.object({
    mail: z.boolean().default(false), budgetPerDay: z.number().int().positive().default(20),
    permitAfterMs: z.number().int().nonnegative().default(20_000),
    blockedMs: z.number().int().nonnegative().default(180_000),
    intervalSeconds: z.number().int().positive().default(5),
  }).default({ mail: false, budgetPerDay: 20, permitAfterMs: 20_000, blockedMs: 180_000, intervalSeconds: 5 }),
  // How seats are permitted (ADR 0020): auto runs Claude seats without asking
  // (bypass, held by slp's deny rules, the git shim and, where there is one,
  // the sandbox); ask keeps Claude Code's prompts for anything not allowed.
  permissions: z.object({ mode: z.enum(["auto", "ask"]).default("auto") }).default({ mode: "auto" }),
  // Where lanes work (ADR 0018): auto (the checkout when clean, on base and
  // free, else ask), newBranch, onBranch or isolate; and a command run in
  // every new working copy before its seat starts.
  lanes: z.object({
    home: z.enum(["auto", "newBranch", "onBranch", "isolate"]).default("auto"),
    setup: z.string().nullable().default(null),
    // Keep a finished copy (clean, detached, its git-ignored caches kept)
    // for the next isolated lane or parallel task instead of deleting it.
    reuseCopies: z.boolean().default(false),
  }).default({ home: "auto", setup: null, reuseCopies: false }),
  // The Human in the loop (ADR 0016, as seatworks' hitl): off, the Supervisor
  // answers seats' permission prompts for the Human; on, the Human does.
  human: z.object({ inLoop: z.boolean().default(false) }).default({ inLoop: false }),
  // Jev (ADR 0013): off, shadow (record only) or on (act where calibrated).
  // Thresholds are set by `slp calibrate`, keyed "<point>.<question>".
  jev: z.object({
    mode: z.enum(["off", "shadow", "on"]).default("shadow"),
    dailyCalls: z.number().int().nonnegative().default(300),
    thresholds: z.record(z.string(), z.number().min(0.5).max(1)).default({}),
  }).default({ mode: "shadow", dailyCalls: 300, thresholds: {} }),
}).superRefine((c, ctx) => {
  for (const [role, rc] of Object.entries(c.roles)) {
    for (const name of [...rc.use, ...Object.values(rc.presets).flatMap((p) => (p.launcher ? [p.launcher] : []))]) {
      if (!c.launchers[name]) ctx.addIssue({ code: "custom", path: ["roles", role], message: `unknown launcher "${name}"` });
    }
    if (rc.defaultPreset && !rc.presets[rc.defaultPreset]) {
      ctx.addIssue({ code: "custom", path: ["roles", role, "defaultPreset"], message: `unknown preset "${rc.defaultPreset}"` });
    }
  }
  for (const role of Role.options) if (!c.roles[role]) ctx.addIssue({ code: "custom", path: ["roles", role], message: "missing role" });
});
export type Config = z.infer<typeof ConfigSchema>;

const OPUS = "claude-opus-5-5[1m]";

/**
 * The defaults: one account per agent, nothing secret, the same on every
 * platform. Several accounts per agent are the owner's own launchers, set
 * up per machine (README: "Several accounts"); slp never ships anyone's.
 */
export function defaultConfig(): Config {
  const peerPresets = {
    sol: { model: "gpt-6-sol", effort: "high" },
    luna: { model: "gpt-6-luna", effort: "high" },
    flash: { launcher: "agy", model: "gemini-3.8-flash-high", effort: "high" },
  };
  return {
    version: 1,
    watch: { mail: false, budgetPerDay: 20, permitAfterMs: 20_000, blockedMs: 180_000, intervalSeconds: 5 },
    permissions: { mode: "auto" },
    jev: { mode: "shadow", dailyCalls: 300, thresholds: {} },
    human: { inLoop: false },
    lanes: { home: "auto", setup: null, reuseCopies: false },
    launchers: {
      claude: { agent: "claude", env: {}, prep: {} },
      codex: { agent: "codex", env: {}, prep: {} },
      agy: { agent: "agy", env: {}, prep: {} },
    },
    roles: {
      supervisor: { use: ["claude"], model: OPUS, effort: "xhigh", presets: {}, defaultPreset: null, allow: [] },
      lead: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null, allow: [] },
      reviewer: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null, allow: [] },
      critic: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null, allow: [] },
      peer: { use: ["codex"], model: "gpt-6-sol", effort: "high", presets: peerPresets, defaultPreset: "sol", allow: [] },
    },
  };
}

export function parseConfig(value: unknown): Config {
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new SlpError(`Invalid slp config: ${issues}`);
  }
  return parsed.data;
}

/** The owner's config, written from the defaults on first use so it can be edited. */
export async function loadConfig(env: Env): Promise<Config> {
  const path = configPath(env);
  let raw: string | null = null;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw === null) {
    const config = defaultConfig();
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new SlpError(`${path} is not valid JSON`);
  }
  return parseConfig(json);
}

/** What a seat of `role` should run: launcher, model and effort. */
export interface SeatChoice { launcherName: string; launcher: Launcher; model: string | null; effort: string | null }

/**
 * Choose the launcher for a new seat. Rotation (several `use` entries) goes by
 * how many seats of that role were opened before. A preset (Peers) may name
 * another launcher and model.
 */
export function chooseSeat(config: Config, role: RoleName, opened: number, presetName?: string | null): SeatChoice {
  const rc = config.roles[role];
  const name = presetName ?? rc.defaultPreset;
  const preset = name ? rc.presets[name] : undefined;
  if (presetName && !preset) {
    throw new SlpError(`Unknown ${role} preset "${presetName}" (known: ${Object.keys(rc.presets).join(", ") || "none"})`);
  }
  const launcherName = preset?.launcher ?? rc.use[opened % rc.use.length]!;
  const launcher = config.launchers[launcherName]!;
  return { launcherName, launcher, model: preset?.model ?? rc.model, effort: preset?.effort ?? rc.effort };
}

export function expandHome(value: string): string {
  return value.replace(/\{home\}/g, homedir());
}

export async function saveConfig(env: Env, config: Config): Promise<void> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(parseConfig(config), null, 2)}\n`);
}
