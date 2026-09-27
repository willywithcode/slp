import type { Env } from "./core/paths.js";
import { SlpError } from "./core/errors.js";
import { readLedger } from "./core/ledger.js";
import { listProjects, loadProject, projectIdFor, rootFor, type Project } from "./core/project.js";
import { fold, type Seat, type State } from "./state.js";

export interface Me { project: Project; state: State; seat: Seat }

/**
 * The seat running this command: the live seat whose pane is this terminal's
 * Herdr pane (and whose team sits in this workspace). Nothing the agent
 * chooses is trusted. Guards against mistakes, not a hostile local process.
 */
export async function whoAmI(env: Env): Promise<Me> {
  const pane = env.HERDR_PANE_ID;
  const workspace = env.HERDR_WORKSPACE_ID;
  if (!pane) throw new SlpError("Not inside a Herdr pane, so not a seat of any slp team.");
  const candidates = env.SLP_PROJECT ? [env.SLP_PROJECT] : await listProjects(env);
  for (const id of candidates) {
    const project = await loadProject(env, id);
    if (!project || (workspace && project.workspaceId && project.workspaceId !== workspace)) continue;
    const state = fold(await readLedger(env, id));
    const seat = [...state.seats.values()].find((s) => s.live && s.paneId === pane);
    if (seat) return { project, state, seat };
  }
  throw new SlpError(`This terminal (pane ${pane}) is not a seat of any slp team. ` +
    "If you are an agent, your commands may run in a shared background process with another pane's " +
    "environment (Codex: start it with --no-daemon).");
}

/** The project of the repository at `cwd`, for the Human's own commands. */
export async function projectHere(env: Env, cwd: string): Promise<{ project: Project; state: State }> {
  const id = projectIdFor(await rootFor(cwd));
  const project = await loadProject(env, id);
  if (!project) throw new SlpError("No slp team for this repository yet; run `slp start` here.");
  return { project, state: fold(await readLedger(env, id)) };
}
