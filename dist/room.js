import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
// Herdr agent names must match [a-z][a-z0-9_-]{0,31}. Member herdr names are
// `<room>-<member>`, so both halves are kept short enough to always fit.
export const ROOM_NAME = /^[a-z][a-z0-9-]{0,19}$/;
export const MEMBER_NAME = /^[a-z][a-z0-9-]{0,9}$/;
export const Role = z.enum(["lead", "peer", "supervisor"]);
const Member = z.object({
    role: Role,
    kind: z.string().min(1),
    herdrName: z.string().min(1),
    paneId: z.string().min(1),
});
const RoomSchema = z.object({
    version: z.literal(1),
    name: z.string().regex(ROOM_NAME),
    cwd: z.string().min(1),
    workspaceId: z.string().min(1),
    createdAt: z.string(),
    members: z.record(z.string().regex(MEMBER_NAME), Member),
});
export class SplError extends Error {
}
/** The room no longer exists (never created, or archived by `spl down`). */
export class RoomGoneError extends SplError {
}
export function splHome(env) {
    return env.SPL_HOME?.trim() || join(homedir(), ".spl");
}
export function roomDir(env, room) {
    if (!ROOM_NAME.test(room))
        throw new SplError(`Invalid room name "${room}": use ${ROOM_NAME.source}`);
    return join(splHome(env), "rooms", room);
}
export async function writeAtomic(path, content) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
}
export async function saveRoom(env, room) {
    const dir = roomDir(env, room.name);
    await mkdir(dir, { recursive: true });
    await writeAtomic(join(dir, "room.json"), `${JSON.stringify(RoomSchema.parse(room), null, 2)}\n`);
}
export async function loadRoom(env, name) {
    let raw;
    try {
        raw = await readFile(join(roomDir(env, name), "room.json"), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    const parsed = RoomSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
        throw new SplError(`Room "${name}" has an unreadable room.json`);
    return parsed.data;
}
export async function listRooms(env) {
    try {
        const entries = await readdir(join(splHome(env), "rooms"), { withFileTypes: true });
        return entries.filter((e) => e.isDirectory() && ROOM_NAME.test(e.name)).map((e) => e.name).sort();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
/**
 * Identify the calling agent from the pane Herdr injected into its terminal
 * (`HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID` when present). Nothing the agent
 * chooses, such as a member name, is trusted. This prevents mistakes, not a
 * deliberately hostile local process, which could forge these variables too.
 */
export async function resolveSelf(env, roomFlag) {
    const candidates = roomFlag ? [roomFlag] : env.SPL_ROOM ? [env.SPL_ROOM] : await listRooms(env);
    const paneId = env.HERDR_PANE_ID;
    const workspaceId = env.HERDR_WORKSPACE_ID;
    for (const name of paneId ? candidates : []) {
        const room = await loadRoom(env, name);
        if (!room || (workspaceId && room.workspaceId !== workspaceId))
            continue;
        for (const [memberName, member] of Object.entries(room.members)) {
            if (member.paneId === paneId)
                return { room, name: memberName, member };
        }
    }
    throw new SplError(`This terminal (pane ${paneId ?? "unknown"}) is not a member of any SPL room. ` +
        "If you are an agent in a room, your commands may be running in a shared background server " +
        "with another pane's environment (Codex: restart it with --no-daemon).");
}
export async function resolveRoom(env, roomFlag) {
    const name = roomFlag ?? env.SPL_ROOM;
    if (name) {
        const room = await loadRoom(env, name);
        if (!room)
            throw new SplError(`Room "${name}" does not exist`);
        return room;
    }
    try {
        return (await resolveSelf(env)).room;
    }
    catch {
        const rooms = await listRooms(env);
        if (rooms.length === 1 && rooms[0])
            return (await loadRoom(env, rooms[0]));
        throw new SplError(rooms.length ? `Several rooms exist; pass --room (${rooms.join(", ")})` : "No SPL rooms exist yet; run `spl up`");
    }
}
