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
});
export type RoleConfig = z.infer<typeof RoleConfig>;

const ConfigSchema = z.object({
  version: z.literal(1),
  launchers: z.record(z.string(), Launcher),
  roles: z.record(Role, RoleConfig),
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

function claudeToken(account: string): Launcher {
  // Same steps as the owner's `claude-as`: decrypt the DPAPI-protected token in
  // the seat's own shell; the value never passes through slp or Herdr.
  return {
    agent: "claude",
    env: { ANTHROPIC_API_KEY: null },
    prep: {
      powershell: `$env:CLAUDE_CODE_OAUTH_TOKEN = [Net.NetworkCredential]::new('', (Get-Content "$HOME\\.secrets\\claude-${account}.txt" | ConvertTo-SecureString)).Password`,
    },
  };
}

function codexHome(account: string): Launcher {
  // Same variables as the owner's `codex-as`.
  return {
    agent: "codex",
    env: { CODEX_HOME: `{home}/.codex-${account}`, CODEX_SQLITE_HOME: "{home}/.codex", OPENAI_API_KEY: null },
    prep: {},
  };
}

/** Defaults per ADR 0011 on the owner's Windows machine; plain agents elsewhere. */
export function defaultConfig(platform: string = process.platform): Config {
  const peerPresets = {
    sol: { model: "gpt-6-sol", effort: "high" },
    luna: { model: "gpt-6-luna", effort: "high" },
    flash: { launcher: "agy", model: "gemini-3.8-flash-high", effort: "high" },
  };
  if (platform === "win32") {
    return {
      version: 1,
      launchers: {
        claude: { agent: "claude", env: {}, prep: {} },
        "claude-acc1": claudeToken("acc1"),
        "claude-acc2": claudeToken("acc2"),
        "codex-acc1": { agent: "codex", env: { OPENAI_API_KEY: null }, prep: {} },
        "codex-acc2": codexHome("acc2"),
        "codex-acc3": codexHome("acc3"),
        agy: { agent: "agy", env: {}, prep: {} },
      },
      roles: {
        supervisor: { use: ["claude"], model: OPUS, effort: "xhigh", presets: {}, defaultPreset: null },
        lead: { use: ["claude-acc1"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
        reviewer: { use: ["claude-acc2"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
        critic: { use: ["claude-acc2"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
        peer: { use: ["codex-acc1", "codex-acc2", "codex-acc3"], model: "gpt-6-sol", effort: "high", presets: peerPresets, defaultPreset: "sol" },
      },
    };
  }
  return {
    version: 1,
    launchers: {
      claude: { agent: "claude", env: {}, prep: {} },
      codex: { agent: "codex", env: {}, prep: {} },
      agy: { agent: "agy", env: {}, prep: {} },
    },
    roles: {
      supervisor: { use: ["claude"], model: OPUS, effort: "xhigh", presets: {}, defaultPreset: null },
      lead: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
      reviewer: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
      critic: { use: ["claude"], model: OPUS, effort: "high", presets: {}, defaultPreset: null },
      peer: { use: ["codex"], model: "gpt-6-sol", effort: "high", presets: peerPresets, defaultPreset: "sol" },
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
export async function loadConfig(env: Env, platform: string = process.platform): Promise<Config> {
  const path = configPath(env);
  let raw: string | null = null;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw === null) {
    const config = defaultConfig(platform);
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
