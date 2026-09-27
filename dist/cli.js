import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as cmd from "./commands.js";
import { Herdr } from "./herdr.js";
import { guide } from "./protocol.js";
import { Role, resolveRoom, resolveSelf, RoomGoneError, roomDir, SplError } from "./room.js";
import { acquireLock, releaseLock } from "./log.js";
import { DEFAULT_WATCH } from "./watch.js";
import { createEvaluator, JEV_MODEL } from "./jev.js";
import { watchTick } from "./watcher.js";
const USAGE = `slp — Supervisor/Lead/Peer rooms on Herdr

Human:
  slp up <room> [--lead KIND] [--peers KIND,KIND] [--supervisor KIND|none] [--cwd DIR] [--watch]
  slp down <room> [--force]
  slp status [--room R]
  slp log <case> [--room R]
  slp watch [--room R] [--once] [--interval SECONDS] [--jev off|shadow|alert]

Agents (inside a room pane):
  slp guide [lead|peer|supervisor]
  slp whoami
  slp send <peer> [TEXT | - | --file PATH]            (lead)
  slp reply <case> <peer> [TEXT | - | --file PATH] [--close]  (lead)
  slp handback <case> [TEXT | - | --file PATH]        (peer)
  slp redeliver [--force] <seq>

KIND is a herdr agent kind (claude, codex, opencode, ...). Default room:
lead claude, peers codex,codex, supervisor claude. Data lives in ~/.slp
(override with SLP_HOME).`;
export async function main(argv, env, deps = { herdr: new Herdr(), out: (s) => console.log(s) }) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            room: { type: "string" },
            file: { type: "string" },
            cwd: { type: "string" },
            lead: { type: "string" },
            peers: { type: "string" },
            supervisor: { type: "string" },
            once: { type: "boolean" },
            force: { type: "boolean" },
            close: { type: "boolean" },
            jev: { type: "string" },
            watch: { type: "boolean" },
            interval: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, ...args] = positionals;
    const d = { env, ...deps };
    const room = values.room;
    const text = async (arg) => {
        if (values.file !== undefined) {
            if (arg !== undefined)
                throw new UsageError("Pass either TEXT or --file, not both");
            return decodeText(await readFile(values.file));
        }
        if (arg === "-")
            return decodeText(await readStdin());
        if (arg === undefined)
            throw new UsageError("Missing message text (TEXT, -, or --file PATH)");
        return arg;
    };
    const arity = (n, m = n) => {
        if (args.length < n || args.length > m)
            throw new UsageError(`Wrong number of arguments for "${command}"`);
    };
    if (!command || values.help || command === "help") {
        deps.out(USAGE);
        return command || values.help ? 0 : 2;
    }
    switch (command) {
        case "up": {
            arity(1);
            await cmd.up(d, {
                room: args[0],
                cwd: values.cwd ?? process.cwd(),
                lead: values.lead ?? "claude",
                peers: (values.peers ?? "codex,codex").split(",").map((s) => s.trim()).filter(Boolean),
                supervisor: values.supervisor === "none" ? null : values.supervisor ?? "claude",
                watch: values.watch === true,
            });
            return 0;
        }
        case "send":
            arity(1, 2);
            await cmd.send(d, room, args[0], await text(args[1]));
            return 0;
        case "reply":
            arity(2, 3);
            await cmd.reply(d, room, args[0], args[1], await text(args[2]), values.close === true);
            return 0;
        case "handback":
            arity(1, 2);
            await cmd.handback(d, room, args[0], await text(args[1]));
            return 0;
        case "redeliver": {
            arity(1);
            const seq = Number(args[0]);
            if (!Number.isInteger(seq) || seq < 1)
                throw new UsageError("seq must be a positive integer");
            await cmd.redeliver(d, room, seq, values.force === true);
            return 0;
        }
        case "down":
            arity(1);
            await cmd.down(d, args[0], values.force === true);
            return 0;
        case "status":
            arity(0);
            await cmd.status(d, room);
            return 0;
        case "log":
            arity(1);
            await cmd.log(d, room, args[0]);
            return 0;
        case "watch": {
            arity(0);
            const target = await resolveRoom(env, room);
            const interval = Number(values.interval ?? 10);
            if (!Number.isFinite(interval) || interval < 1)
                throw new UsageError("--interval must be at least 1 second");
            const jev = jevOptions(values.jev ?? "off", env, deps.fetch);
            // One watcher per room: two would double Jev spend and alert deliveries.
            // A crashed watcher's lock is reclaimed because its pid is gone.
            const lock = join(roomDir(env, target.name), "watch.lock");
            const token = await acquireLock(lock, {
                timeoutMs: 0,
                reclaimForeign: false,
                busy: (owner) => `Room ${target.name} is already watched by pid ${owner?.pid ?? "unknown"}${owner ? ` on ${owner.host}` : ""}`,
            });
            try {
                if (values.once) {
                    await watchTick(d, target, DEFAULT_WATCH, jev);
                    return 0;
                }
                deps.out(`watching room ${target.name} every ${interval}s (Ctrl+C to stop)`);
                for (;;) {
                    try {
                        await watchTick(d, target, DEFAULT_WATCH, jev);
                    }
                    catch (error) {
                        if (error instanceof RoomGoneError) {
                            deps.out(`watch: ${error.message}; stopping`);
                            return 0;
                        }
                        // Keep watching: herdr may be restarting or briefly unavailable.
                        deps.out(`watch: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    await new Promise((r) => setTimeout(r, interval * 1000));
                }
            }
            finally {
                await releaseLock(lock, token).catch(() => undefined);
            }
        }
        case "whoami": {
            arity(0);
            const self = await resolveSelf(env, room);
            deps.out(`${self.name} (${self.member.role}) in room ${self.room.name}`);
            return 0;
        }
        case "guide": {
            arity(0, 1);
            const role = args[0] !== undefined ? Role.safeParse(args[0]) : null;
            if (role && !role.success)
                throw new UsageError("Role must be lead, peer or supervisor");
            deps.out(guide(role?.data ?? (await resolveSelf(env, room)).member.role));
            return 0;
        }
        default:
            throw new UsageError(`Unknown command "${command}"`);
    }
}
class UsageError extends Error {
}
/** Jev is off unless asked for (ADR 0005); when on, its config must be valid. */
function jevOptions(mode, env, http = fetch) {
    if (mode !== "off" && mode !== "shadow" && mode !== "alert")
        throw new UsageError("--jev must be off, shadow or alert");
    const disabled = { mode: "off", evaluate: async () => null, threshold: 1 };
    if (mode === "off")
        return disabled;
    const apiKey = env.JEV_API_KEY?.trim();
    if (!apiKey)
        throw new SplError(`--jev ${mode} needs JEV_API_KEY in the environment`);
    const model = env.JEV_MODEL?.trim() || "jev-1.13.0";
    if (!JEV_MODEL.test(model))
        throw new SplError("JEV_MODEL must be a pinned version such as jev-1.13.0, not an alias");
    const threshold = Number(env.SLP_ALERT_CONFIDENCE ?? 0.9);
    if (!(threshold >= 0.5 && threshold <= 1))
        throw new SplError("SLP_ALERT_CONFIDENCE must be a number from 0.5 to 1");
    return { mode, evaluate: createEvaluator({ apiKey, model }, http), threshold };
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}
/**
 * UTF-8 (with or without BOM) or BOM-marked UTF-16, which Windows PowerShell
 * 5.1 writes with `>` and Out-File.
 */
export function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
}
export async function run(argv, env) {
    try {
        return await main(argv, env);
    }
    catch (error) {
        if (error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS")) {
            console.error(`slp: ${error.message}\nRun \`slp help\` for usage.`);
            return 2;
        }
        console.error(`slp: ${error instanceof SplError ? error.message : error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
