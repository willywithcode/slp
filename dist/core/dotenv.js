import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SlpError } from "./errors.js";
import { slpHome } from "./paths.js";
// slp's own secrets file, `~/.slp/.env` (outside every repository): keys for
// slp itself (Jev), read by each slp process. Seats never get them: they are
// not put into any pane. The environment wins over the file. Values are never
// printed or logged.
const BOM = String.fromCharCode(0xfeff);
export function dotenvPath(env) {
    return join(slpHome(env), ".env");
}
/** KEY=VALUE lines; # comments; optional `export`; values optionally in single or double quotes. */
export function parseDotenv(text) {
    const out = {};
    const body = text.startsWith(BOM) ? text.slice(1) : text;
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m)
            continue;
        let value = m[2].trim();
        const quoted = /^(["'])(.*)\1$/.exec(value);
        if (quoted)
            value = quoted[2];
        else
            value = value.replace(/\s+#.*$/, "");
        out[m[1]] = value;
    }
    return out;
}
/**
 * The environment with `~/.slp/.env` underneath it. On macOS and Linux the
 * file must be private (no access for group or others), like an SSH key.
 */
export async function withDotenv(env, platform = process.platform) {
    const path = dotenvPath(env);
    const info = await stat(path).catch(() => null);
    if (!info)
        return env;
    if (platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new SlpError(`${path} is readable by other users; run: chmod 600 ${path}`);
    }
    const file = parseDotenv(await readFile(path, "utf8"));
    const merged = { ...file };
    for (const [k, v] of Object.entries(env))
        if (v !== undefined)
            merged[k] = v;
    return merged;
}
