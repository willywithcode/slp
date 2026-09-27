import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { currentBranch, toplevel } from "../git.js";
import { SlpError } from "./errors.js";
import { writeAtomic } from "./fsutil.js";
import { append, readLedger } from "./ledger.js";
import { projectDir, projectsDir } from "./paths.js";
const ProjectSchema = z.object({
    version: z.literal(1),
    id: z.string(),
    root: z.string(),
    createdAt: z.string(),
    // Where the team sits (ADR 0012): the Human's workspace and first tab.
    workspaceId: z.string().nullable(),
    mainTabId: z.string().nullable(),
    humanPane: z.string().nullable(),
    // The pane running `slp watch` for this team, when slp started it.
    watchPane: z.string().nullable().default(null),
});
/** Stable id for a repository: readable name plus a hash of its absolute path. */
export function projectIdFor(root) {
    const normalized = resolve(root).split("\\").join("/").toLowerCase();
    const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "project";
    return `${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 6)}`;
}
/** The repository root for `cwd` (git top level), or `cwd` itself outside git. */
export async function rootFor(cwd) {
    // git prints forward slashes on Windows; keep native paths throughout.
    return resolve((await toplevel(cwd)) ?? cwd);
}
export function contextPath(env, id) {
    return join(projectDir(env, id), "CONTEXT.md");
}
export async function loadProject(env, id) {
    let raw;
    try {
        raw = await readFile(join(projectDir(env, id), "project.json"), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
        throw new SlpError(`Project ${id} has an unreadable project.json`);
    return parsed.data;
}
export async function saveProject(env, project) {
    await writeAtomic(join(projectDir(env, project.id), "project.json"), `${JSON.stringify(ProjectSchema.parse(project), null, 2)}\n`);
}
/** Load the project for a repository, creating its state directory the first time. */
export async function ensureProject(env, cwd) {
    const root = await rootFor(cwd);
    const id = projectIdFor(root);
    const existing = await loadProject(env, id);
    if (existing)
        return existing;
    const dir = projectDir(env, id);
    await mkdir(dir, { recursive: true });
    const project = { version: 1, id, root, createdAt: new Date().toISOString(), workspaceId: null, mainTabId: null, humanPane: null, watchPane: null };
    await saveProject(env, project);
    const events = await readLedger(env, id);
    if (!events.some((e) => e.kind === "project")) {
        const base = (await currentBranch(root)) ?? "main";
        await append(env, id, () => ({ kind: "project", base, gate: null, gateTimeoutMinutes: 30, landAs: "squash" }));
    }
    return project;
}
export async function listProjects(env) {
    try {
        const entries = await readdir(projectsDir(env), { withFileTypes: true });
        const ids = [];
        for (const e of entries) {
            if (e.isDirectory() && await stat(join(projectsDir(env), e.name, "project.json")).then(() => true, () => false))
                ids.push(e.name);
        }
        return ids.sort();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
