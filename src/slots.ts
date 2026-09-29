import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Deps } from "./core/deps.js";
import { append, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import type { Project } from "./core/project.js";
import { existsSync } from "node:fs";
import { loadConfig, type Config } from "./core/config.js";
import { addWorktree, freeWorktree, gitOk, removeWorktree } from "./git.js";
import { fold, type State } from "./state.js";

// Working copies slp makes for lanes and parallel tasks (ADR 0008). Released
// thoroughly when their work is over; one that still holds uncommitted work
// is kept, recorded, shown in `slp status`, reported to the Human, retried by
// the watcher, and removable with `slp clean`.

/**
 * Release a copy slp made: kept clean for reuse when the config says so,
 * else removed. `remove` (slp clean) removes even a reusable one; `force`
 * discards uncommitted changes. Returns why it was kept, or null.
 */
export async function releaseCopy(deps: Deps, project: Project, path: string, owner: string,
  opts: { remove?: boolean; force?: boolean } = {}): Promise<string | null> {
  const state = fold(await readLedger(deps.env, project.id));
  // A reused copy may belong to someone else by now: never release it for them.
  const user = inUse(state).get(path);
  if (user && user !== owner) return null;
  if (!opts.remove && existsSync(path) && (await loadConfig(deps.env).catch(() => null))?.lanes.reuseCopies) {
    if ((await freeWorktree(path)) === null) {
      await append(deps.env, project.id, () => ({ kind: "slot-free" as const, path }));
      return null;
    }
  }
  const why = await removeWorktree(project.root, path, opts.force === true);
  const kept = state.keptSlots.get(path);
  if (why) {
    if (kept?.why !== why) {
      await append(deps.env, project.id, () => ({ kind: "slot-kept" as const, path, owner, why }));
      await deps.herdr.notify(`slp: kept ${owner}'s working copy`, `${path}: ${why}. Clean it with: slp clean`).catch(() => undefined);
    }
  } else if (kept || state.freeSlots.has(path)) {
    await append(deps.env, project.id, () => ({ kind: "slot-cleared" as const, path }));
  }
  return why;
}

/** Where a new copy goes: a free one when copies are reused (ADR 0018), else `fresh`. Called under the ledger lock. */
export function pickSlot(state: State, config: Config, fresh: string): { path: string; reused: boolean } {
  if (!config.lanes.reuseCopies) return { path: fresh, reused: false };
  const used = inUse(state);
  const free = [...state.freeSlots].find((p) => !used.has(p) && existsSync(p));
  return free ? { path: free, reused: true } : { path: fresh, reused: false };
}

/** Make a copy on a new `branch` from `from`: a free copy is switched over, else a worktree is added. */
export async function makeCopy(root: string, slot: { path: string; reused: boolean }, branch: string, from: string): Promise<void> {
  if (slot.reused) await gitOk(slot.path, ["switch", "-c", branch, from]);
  else await addWorktree(root, slot.path, branch, from);
}

/** Copies some open lane or unfinished task still works in, and whose they are. */
function inUse(state: State): Map<string, string> {
  const used = new Map<string, string>();
  for (const lane of state.lanes.values()) if (lane.open) used.set(lane.workdir, lane.id);
  for (const task of state.tasks.values()) {
    if (state.lanes.get(task.lane)?.open && task.mode === "parallel" && ["running", "handed-back", "rework"].includes(task.state)) used.set(task.workdir, task.id);
  }
  return used;
}

/** Try the kept copies again: one whose work was committed or discarded meanwhile goes. */
export async function sweepKept(deps: Deps, project: Project, state: State): Promise<void> {
  const used = inUse(state);
  for (const slot of state.keptSlots.values()) {
    if (used.has(slot.path)) continue;
    if (!(await releaseCopy(deps, project, slot.path, slot.owner))) deps.out(`removed ${slot.owner}'s kept working copy ${slot.path}`);
  }
}

/**
 * The Human's `slp clean`: remove every copy slp kept, and any folder left
 * under the project's slots that no open lane or task uses. `force` discards
 * uncommitted changes too.
 */
export async function cleanSlots(deps: Deps, project: Project, force: boolean): Promise<void> {
  const state = fold(await readLedger(deps.env, project.id));
  const used = inUse(state);
  const slots = join(projectDir(deps.env, project.id), "slots");
  const found = new Map([...state.keptSlots.values()].map((s) => [s.path, s.owner]));
  for (const name of await readdir(slots).catch(() => [] as string[])) {
    const path = join(slots, name);
    if (!found.has(path)) found.set(path, name);
  }
  let removed = 0;
  let kept = 0;
  for (const [path, owner] of found) {
    if (used.has(path)) continue;
    const why = await releaseCopy(deps, project, path, owner, { remove: true, force });
    if (why) {
      kept += 1;
      deps.out(`kept ${path}: ${why}${force ? "" : " (slp clean --force discards it)"}`);
    } else {
      removed += 1;
      deps.out(`removed ${path}`);
    }
  }
  deps.out(removed + kept ? `${removed} removed, ${kept} kept` : "No working copies to clean.");
}
