import { SlpError } from "./core/errors.js";
export function shellFamily(processNames) {
    for (const raw of processNames) {
        const name = raw.toLowerCase().replace(/\.exe$/, "");
        if (name === "powershell" || name === "pwsh")
            return "powershell";
        if (["bash", "zsh", "sh", "fish", "dash", "ksh"].includes(name))
            return "sh";
        if (name === "cmd")
            return "cmd";
    }
    return null;
}
function quotePs(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function quoteSh(value) {
    // Close the quote, add an escaped quote, reopen: it's -> 'it'\''s'
    return `'${value.split("'").join(`'${"\\"}''`)}'`;
}
/** Commands that set (or, for null, unset) each variable in the given shell. */
export function envCommands(family, env) {
    return Object.entries(env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new SlpError(`Invalid environment variable name "${key}"`);
        if (family === "powershell") {
            return value === null ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue` : `$env:${key} = ${quotePs(value)}`;
        }
        if (family === "sh")
            return value === null ? `unset ${key}` : `export ${key}=${quoteSh(value)}`;
        if (value !== null && /["^&|<>%]/.test(value))
            throw new SlpError(`Cannot set ${key} safely in cmd.exe`);
        return value === null ? `set "${key}="` : `set "${key}=${value}"`;
    });
}
/**
 * A command that prints `slp-ready-<nonce>` once everything typed before it
 * has run. The marker is assembled at run time, so the typed command itself
 * never contains the text being waited for.
 */
export function readyProbe(family, nonce) {
    const match = `slp-ready-${nonce}`;
    if (family === "powershell")
        return { command: `Write-Output ('slp-ready-' + '${nonce}')`, match };
    if (family === "sh")
        return { command: `printf 'slp-ready-%s\\n' '${nonce}'`, match };
    // cmd drops the caret when echoing: typed "slp-ready^-x", printed "slp-ready-x".
    return { command: `echo slp-ready^-${nonce}`, match };
}
export function joinCommands(family, commands) {
    return commands.join(family === "cmd" ? " & " : "; ");
}
/** A command that puts `dir` first on PATH in the given shell. */
export function pathPrepend(family, dir) {
    if (family === "powershell")
        return `$env:PATH = ${quotePs(`${dir};`)} + $env:PATH`;
    if (family === "sh")
        return `export PATH=${quoteSh(dir)}:"$PATH"`;
    if (/["^&|<>%]/.test(dir))
        throw new SlpError(`Cannot put ${dir} on PATH safely in cmd.exe`);
    return `set "PATH=${dir};%PATH%"`;
}
