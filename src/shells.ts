import { SlpError } from "./core/errors.js";

// A seat's pane runs the user's shell. slp speaks to it in that shell's own
// syntax to set a launcher's environment and run its preparation (ADR 0011).

export type ShellFamily = "powershell" | "sh" | "cmd";

export function shellFamily(processNames: readonly string[]): ShellFamily | null {
  for (const raw of processNames) {
    const name = raw.toLowerCase().replace(/\.exe$/, "");
    if (name === "powershell" || name === "pwsh") return "powershell";
    if (["bash", "zsh", "sh", "fish", "dash", "ksh"].includes(name)) return "sh";
    if (name === "cmd") return "cmd";
  }
  return null;
}

function quotePs(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteSh(value: string): string {
  // Close the quote, add an escaped quote, reopen: it's -> 'it'\''s'
  return `'${value.split("'").join(`'${"\\"}''`)}'`;
}

/** Commands that set (or, for null, unset) each variable in the given shell. */
export function envCommands(family: ShellFamily, env: Readonly<Record<string, string | null>>): string[] {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new SlpError(`Invalid environment variable name "${key}"`);
    if (family === "powershell") {
      return value === null ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue` : `$env:${key} = ${quotePs(value)}`;
    }
    if (family === "sh") return value === null ? `unset ${key}` : `export ${key}=${quoteSh(value)}`;
    if (value !== null && /["^&|<>%]/.test(value)) throw new SlpError(`Cannot set ${key} safely in cmd.exe`);
    return value === null ? `set "${key}="` : `set "${key}=${value}"`;
  });
}

/**
 * A command that prints `slp-ready-<nonce>` once everything typed before it
 * has run. The marker is assembled at run time, so the typed command itself
 * never contains the text being waited for.
 */
export function readyProbe(family: ShellFamily, nonce: string): { command: string; match: string } {
  const match = `slp-ready-${nonce}`;
  if (family === "powershell") return { command: `Write-Output ('slp-ready-' + '${nonce}')`, match };
  if (family === "sh") return { command: `printf 'slp-ready-%s\\n' '${nonce}'`, match };
  // cmd drops the caret when echoing: typed "slp-ready^-x", printed "slp-ready-x".
  return { command: `echo slp-ready^-${nonce}`, match };
}

export function joinCommands(family: ShellFamily, commands: readonly string[]): string {
  return commands.join(family === "cmd" ? " & " : "; ");
}
