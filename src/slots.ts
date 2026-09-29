import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Deps } from "./core/deps.js";
import { append, readLedger } from "./core/ledger.js";
import { projectDir } from "./core/paths.js";
import type { Project } from "./core/project.js";
import { removeWorktree } from "./git.js";
import { fold, type State } from "./state.js";

// Working copies slp makes for lanes and parallel tasks (ADR 0008). Released
// thoroughly when their work is over; one that still holds uncommitted work
// is kept, recorded, shown in `slp status`, reported to the Human, retried by
// the watcher, and removable with `slp clean`.

/** Remove a copy slp made; returns why it was kept, or null when it is gone. */
export async function releaseCopy(deps: Deps, project: Project, path: string, owner: string, force = false): Promise<string | null> {
  const why = await removeWorktree(project.root, path, force);
  const kept = fold(await readLedger(deps.env, project.id)).keptSlots.get(path);
  if (why) {
    if (kept?.why !== why) {
      await append(deps.env, project.id, () => ({ kind: "slot-kept" as const, path, owner, why }));
      await deps.herdr.notify(`slp: kept ${owner}'s working copy`, `${path}: ${why}. Clean it with: slp clean`).catch(() => undefined);
    }
  } else if (kept) {
    await append(deps.env, project.id, () => ({ kind: "slot-cleared" as const, path }));
  }
  return why;
}

/** Copies some open lane or unfinished task still works in. */
function inUse(state: State): Set<string> {
  const used = new Set<string>();
  for (const lane of state.lanes.values()) if (lane.open) used.add(lane.workdir);
  for (const task of state.tasks.values()) {
    if (state.lanes.get(task.lane)?.open && task.mode === "parallel" && ["running", "handed-back", "rework"].includes(task.state)) used.add(task.workdir);
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
    const why = await releaseCopy(deps, project, path, owner, force);
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
