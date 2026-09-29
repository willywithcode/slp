import { join } from "node:path";
import { loadConfig, type Config } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { SlpError } from "./core/errors.js";
import { append, readLedger, type EventOf, type SlpEvent } from "./core/ledger.js";
import { configPath, projectDir } from "./core/paths.js";
import { contextPath, type Project } from "./core/project.js";
import { readFile } from "node:fs/promises";
import { criticPrefilter } from "./jev/desk.js";
import { currentBranch, dirtyPaths, git, gitOk, head, statusLines } from "./git.js";
import { prepareCopy, submoduleWarning } from "./prepare.js";
import { makeCopy, pickSlot, releaseCopy } from "./slots.js";
import { isCatchAll, matches, overlaps } from "./globs.js";
import { intro } from "./guide.js";
import { describe, sendLetter } from "./letters.js";
import { closeSeat, openSeat } from "./seats.js";
import { humanWordsSince } from "./watch/transcripts.js";
import { laneRisky } from "./risk.js";
import { fold, liveSeats, type Lane, type State } from "./state.js";

export type Home = "auto" | "newBranch" | "onBranch" | "isolate";

export interface LaneInput {
  title: string;
  outcome: string;
  acceptance: string[];
  outOfScope: string[];
  writeSet: string[];
  humanWords: string;
  /** Where the lane works; null takes the config's `lanes.home`. */
  home: Home | null;
  /** Take the checkout's uncommitted changes into a newBranch lane. */
  carry: boolean;
  /** Wait for this lane to close, then open in the checkout. */
  after: string | null;
}

/** What slp found in the Human's checkout. */
export interface Checkout { branch: string | null; changes: string[]; busyWith: string | null }

export type Placement = { home: "newBranch" | "onBranch" | "isolate" } | { refused: string; short: string };

const MAX_SHOWN = 8;

function shown(changes: readonly string[]): string {
  return changes.slice(0, MAX_SHOWN).map((c) => `  ${c}`).join("\n") + (changes.length > MAX_SHOWN ? `\n  … and ${changes.length - MAX_SHOWN} more` : "");
}

/**
 * Where a lane works (ADR 0018). slp never makes a copy of the repository
 * unless asked (isolate); when the checkout cannot take the lane, it says
 * why and what the choices are, for the Supervisor to settle with the Human.
 */
export function placeLane(asked: Home, c: Checkout, base: string, carry: boolean): Placement {
  if (asked === "isolate") return { home: "isolate" };
  if (c.busyWith) {
    return {
      short: `your checkout is in use by lane ${c.busyWith}`,
      refused: `Your checkout is in use by lane ${c.busyWith}. Choose:\n` +
        `  --after ${c.busyWith}     wait: slp opens this lane in the checkout once ${c.busyWith} closes\n` +
        "  --home isolate   a separate working copy (a full checkout of the repository under ~/.slp) now",
    };
  }
  if (asked === "onBranch") {
    if (!c.branch) return { short: "your checkout is not on a branch", refused: "Your checkout is not on a branch (detached HEAD); onBranch needs one. Ask the Human to switch to a branch." };
    return { home: "onBranch" };
  }
  if (c.changes.length && !carry) {
    return {
      short: `your checkout has uncommitted changes (${c.changes[0]}${c.changes.length > 1 ? `, +${c.changes.length - 1}` : ""})`,
      refused: `Your checkout has uncommitted changes to ${c.changes.length} tracked file(s):\n${shown(c.changes)}\n` +
        "slp does not start a lane over them, nor copy the repository without being asked. Choose, with the Human:\n" +
        `  --home onBranch          work on ${c.branch ?? "the current branch"} as it is: the changes stay, the lane commits onto it; landing moves no branch\n` +
        "  --home newBranch --carry a lane branch here that takes the changes over: they land with the lane\n" +
        "  commit or stash them     (the Human), then open the lane again\n" +
        "  --home isolate           a separate working copy (a full checkout under ~/.slp); the changes stay where they are",
    };
  }
  if (asked === "auto" && c.branch !== base) {
    return {
      short: `your checkout is on ${c.branch ?? "a detached HEAD"}, not ${base}`,
      refused: `Your checkout is on ${c.branch ?? "a detached HEAD"}, not the base ${base}. Choose, with the Human:\n` +
        (c.branch ? `  --home onBranch    work on ${c.branch} itself; landing moves no branch\n` : "") +
        `  --home newBranch   switch the checkout to a new lane branch from ${base}\n` +
        `  set the base       \`slp set-project --base ${c.branch ?? "<branch>"}\`, then open the lane again\n` +
        "  --home isolate     a separate working copy (a full checkout under ~/.slp)",
    };
  }
  return { home: "newBranch" };
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32).replace(/^-+|-+$/g, "") || "lane";
}

export function checkWriteSet(state: State, writeSet: readonly string[], except?: string): void {
  if (!writeSet.length) throw new SlpError("A lane needs a write set: --write \"src/area/**\" (repeatable).");
  const wide = writeSet.filter(isCatchAll);
  if (wide.length) throw new SlpError(`Write set too wide (${wide.join(", ")}): name the areas this outcome changes.`);
  for (const lane of state.lanes.values()) {
    if (!lane.open || lane.id === except) continue;
    if (overlaps(writeSet, lane.writeSet)) {
      throw new SlpError(`Write set overlaps open lane ${lane.id} (${lane.writeSet.join(", ")}). ` +
        `Amend ${lane.id} instead, or wait for it to close.`);
    }
  }
}

function directive(lane: Lane): string {
  const lines = [
    `Lane ${lane.id}: ${lane.title}`,
    "",
    `Outcome: ${lane.outcome}`,
    "",
    "Acceptance:",
    ...lane.acceptance.map((a) => `- ${a}`),
    ...(lane.outOfScope.length ? ["", "Out of scope:", ...lane.outOfScope.map((o) => `- ${o}`)] : []),
    "",
    `Write set: ${lane.writeSet.join(", ")}`,
    `Branch: ${lane.branch}   Working copy: ${lane.workdir}   Base: ${lane.base} @ ${lane.baseCommit.slice(0, 10)}`,
    "The Human's concept (read-only for you): `slp context`",
    ...(lane.humanWords ? ["", "The Human asked:", lane.humanWords] : []),
  ];
  if (lane.home === "onBranch") {
    lines.push("", `You work on the Human's own branch ${lane.branch}, in their checkout, which may hold their uncommitted changes. ` +
      "Peers commit only paths in the write set (`git add <path>`, never `git add -A` or `git add .`). " +
      `Landing moves no branch: the lane's commits are already on ${lane.branch}; slp runs the gate and checks holds.`);
  }
  if (lane.carried.length) {
    lines.push("", "The Human's uncommitted changes were carried into this lane and land with it; have a Peer commit them with the lane's work:",
      ...lane.carried.map((c) => `  ${c}`));
  }
  const risky = laneRisky(lane);
  if (risky) lines.push("", `High-risk lane (${risky}): get a review of the whole lane (\`slp start-review --lane\`) before reporting ready; slp holds the landing until then.`);
  return lines.join("\n");
}

/** Lane ids count lanes opened and lanes queued, so a queued lane keeps its id. */
function nextLaneId(events: readonly SlpEvent[]): string {
  return `L${new Set(events.flatMap((e) => (e.kind === "lane-open" || e.kind === "lane-queued" ? [e.lane] : []))).size + 1}`;
}

export async function openLane(deps: Deps, project: Project, config: Config, input: LaneInput, queuedAs?: string): Promise<Lane | null> {
  if (!input.title.trim() || !input.outcome.trim()) throw new SlpError("A lane needs --title and --outcome.");
  if (!input.acceptance.length) throw new SlpError("A lane needs acceptance: --accept \"...\" (repeatable).");
  const before = fold(await readLedger(deps.env, project.id));
  // The Human's own words since the last lane (from the Supervisor's
  // transcript), else what the Supervisor quoted.
  const sup = before.seats.get("sup");
  const since = [...before.lanes.values()].at(-1)?.openedAt ?? sup?.openedAt ?? new Date(0).toISOString();
  const typed = queuedAs || !sup?.sessionId ? [] : await humanWordsSince(deps.env, sup.sessionId, since).catch(() => []);
  const humanWords = typed.length ? typed.join("\n\n") : input.humanWords;

  if (!queuedAs) checkWriteSet(before, input.writeSet, input.after ?? undefined);

  if (input.after && !queuedAs) {
    const after = input.after;
    const queued = await append(deps.env, project.id, (events) => {
      const state = fold(events);
      if (!state.lanes.get(after)?.open && !state.queued.has(after)) throw new SlpError(`No open or queued lane ${after} to wait for.`);
      checkWriteSet(state, input.writeSet, after);
      return {
        kind: "lane-queued" as const, lane: nextLaneId(events), after,
        input: {
          title: input.title, outcome: input.outcome, acceptance: input.acceptance, outOfScope: input.outOfScope,
          writeSet: input.writeSet, humanWords, ...(input.home ? { home: input.home } : {}), ...(input.carry ? { carry: true } : {}),
        },
      };
    });
    deps.out(`lane ${queued.lane} queued: it opens in your checkout once ${after} closes (\`slp status\` shows it; drop it with \`slp close-lane ${queued.lane} --drop --reason "..."\`)`);
    return null;
  }

  const base = before.settings.base;
  const baseCommit = await head(project.root, base);
  const checkout: Checkout = {
    branch: await currentBranch(project.root),
    changes: await statusLines(project.root, false),
    busyWith: [...before.lanes.values()].find((l) => l.open && l.inCheckout)?.id ?? null,
  };
  const asked = input.home ?? config.lanes.home;
  const placed = placeLane(asked, checkout, base, input.carry);
  if ("refused" in placed) {
    await deps.herdr.notify(`slp: a lane waits on your choice`, `"${input.title}": ${placed.short}. The Supervisor has the options.`).catch(() => undefined);
    throw new SlpError(`Lane "${input.title}" not opened.\n${placed.refused}\nThe default is \`lanes.home\` in ${configPath(deps.env)}.`);
  }
  const home = placed.home;
  const inCheckout = home !== "isolate";
  const branchHere = home === "onBranch" ? checkout.branch! : null;
  const hereCommit = branchHere ? await head(project.root, "HEAD") : null;
  const slots = join(projectDir(deps.env, project.id), "slots");

  let slot = { path: project.root, reused: false };
  // The lane is reserved under the ledger lock (its id, write set and working
  // copy are decided against the current record), then its branch is made.
  const opened = await append(deps.env, project.id, (events) => {
    const state = fold(events);
    if (queuedAs && !state.queued.has(queuedAs)) throw new SlpError(`Lane ${queuedAs} is no longer queued.`);
    const waitedFor = queuedAs ? state.queued.get(queuedAs)!.after : undefined;
    checkWriteSet(state, input.writeSet, waitedFor);
    if (inCheckout && [...state.lanes.values()].some((l) => l.open && l.inCheckout)) throw new SlpError("Another lane took your checkout meanwhile; open this one again.");
    const id = queuedAs ?? nextLaneId(events);
    if (!inCheckout) slot = pickSlot(state, config, join(slots, id));
    return {
      kind: "lane-open" as const, lane: id, title: input.title, outcome: input.outcome, acceptance: input.acceptance,
      outOfScope: input.outOfScope, writeSet: input.writeSet, branch: branchHere ?? `lane/${id}-${slug(input.title)}`,
      workdir: inCheckout ? project.root : slot.path, inCheckout, home,
      base: branchHere ?? base, baseCommit: hereCommit ?? baseCommit, humanWords,
      ...(home === "newBranch" && checkout.changes.length ? { carried: checkout.changes } : {}),
    };
  });
  const { lane: id, branch, workdir } = opened;
  try {
    if (home === "newBranch") await gitOk(project.root, ["checkout", "-b", branch, baseCommit]);
    else if (home === "isolate") await makeCopy(project.root, slot, branch, baseCommit);
  } catch (error) {
    await append(deps.env, project.id, () => ({
      kind: "lane-close" as const, lane: id, landed: false, reason: `its branch could not be made: ${describe(error)}`, commit: null, overGate: false,
    }));
    if (slot.reused) await releaseCopy(deps, project, workdir, id).catch(() => undefined);
    throw error;
  }
  const lane = fold(await readLedger(deps.env, project.id)).lanes.get(id)!;
  deps.out(`lane ${id} opened ${home === "onBranch" ? `on your branch ${branch}` : `on ${branch}`} (${inCheckout ? "your checkout" : workdir})`);
  // A new copy is made ready before its Lead starts (ADR 0019); the Lead hears how it went.
  const notes = home === "isolate" ? await prepareCopy(project.root, workdir, config, before.settings.gateTimeoutMinutes * 60_000) : [];
  const sub = await submoduleWarning(project.root, input.writeSet);
  if (sub) notes.push(sub);
  for (const note of notes) deps.out(note);

  const lead = await openSeat(deps, project, config, {
    name: id, role: "lead", lane: id, task: null, cwd: workdir, place: { kind: "tab", label: `${id} ${input.title}`.slice(0, 40) },
    intro: intro(id, "lead", ` (lane ${id}: ${input.title})`, config.launchers[config.roles.lead.use[0]!]?.agent ?? "claude"),
    brief: { letter: "DIRECTIVE", from: "sup", text: [directive(lane), ...notes].join("\n\n") },
  });
  if (lead.attention) deps.out(`NEEDS ATTENTION: ${lead.attention}`);

  if (lane.humanWords.trim()) await openCritic(deps, project, config, lane, lead.seat.paneId);
  return lane;
}

/** A Critic reads the lane against the Human's words once (ADR 0007); the lane runs without one if it cannot open. */
async function openCritic(deps: Deps, project: Project, config: Config, lane: Lane, beside: string): Promise<void> {
  const name = `${lane.id}-critic`;
  try {
    // Catalogue 19: an optional machine first pass, context for the Critic only.
    const concept = await readFile(contextPath(deps.env, project.id), "utf8").catch(() => "");
    const first = await criticPrefilter(deps, project.id, config, lane, concept).catch(() => null);
    const critic = await openSeat(deps, project, config, {
      name, role: "critic", lane: lane.id, task: null, cwd: lane.workdir,
      place: { kind: "split", from: beside, direction: "down" },
      intro: intro(name, "critic", ` (lane ${lane.id})`, config.launchers[config.roles.critic.use[0]!]?.agent ?? "claude"),
      brief: {
        letter: "MESSAGE", from: "slp",
        text: [
          "Read this lane against the Human's own words and the concept (`slp context`), then report with `slp findings`.",
          "", "The Human's words:", lane.humanWords, "", "The lane:", directive(lane),
          ...(first ? ["", first] : []),
        ].join("\n"),
      },
    });
    if (critic.attention) deps.out(`NEEDS ATTENTION: ${critic.attention}`);
  } catch (error) {
    deps.out(`The Critic for ${lane.id} could not open (${describe(error)}); the lane runs without it.`);
  }
}

export interface Amendment { why: string; outcome?: string; acceptance?: string[]; outOfScope?: string[]; writeSet?: string[] }

export async function amendLane(deps: Deps, project: Project, laneId: string, a: Amendment): Promise<void> {
  const state = fold(await readLedger(deps.env, project.id));
  const lane = state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(`No open lane ${laneId}`);
  if (!a.why.trim()) throw new SlpError("Say why: --why \"...\"");
  if (a.writeSet) checkWriteSet(state, a.writeSet, laneId);
  const sub = a.writeSet ? await submoduleWarning(project.root, a.writeSet) : null;
  if (sub) deps.out(sub);
  await append(deps.env, project.id, () => ({
    kind: "lane-amend" as const, lane: laneId, why: a.why,
    ...(a.outcome !== undefined ? { outcome: a.outcome } : {}),
    ...(a.acceptance !== undefined ? { acceptance: a.acceptance } : {}),
    ...(a.outOfScope !== undefined ? { outOfScope: a.outOfScope } : {}),
    ...(a.writeSet !== undefined ? { writeSet: a.writeSet } : {}),
  }));
  const changed = [a.outcome !== undefined && `outcome: ${a.outcome}`, a.acceptance && `acceptance: ${a.acceptance.join(" | ")}`,
    a.outOfScope && `out of scope: ${a.outOfScope.join(" | ")}`, a.writeSet && `write set: ${a.writeSet.join(", ")}`].filter(Boolean);
  await sendLetter(deps, project.id, { letter: "MESSAGE", from: "sup", to: laneId, lane: laneId,
    text: `Lane ${laneId} amended (${a.why}).\n${changed.join("\n")}` });
}

/**
 * Close a lane's seats and tab, remove its worktrees, and put the Human's
 * checkout back on base. Safe to run again (after a crash). Never discards
 * work: a worktree with uncommitted changes is kept. Returns what the Human
 * must know (things it could not do).
 */
export async function teardownLane(deps: Deps, project: Project, lane: Lane, state: State): Promise<string[]> {
  const problems: string[] = [];
  for (const seat of liveSeats(state).filter((s) => s.lane === lane.id)) await closeSeat(deps, project.id, seat, `lane ${lane.id} closed`);
  const tab = state.seats.get(lane.id)?.tabId;
  if (tab && tab !== project.mainTabId) await deps.herdr.tabClose(tab).catch(() => undefined);
  for (const task of state.tasks.values()) {
    if (task.lane !== lane.id || task.mode !== "parallel") continue;
    const why = await releaseCopy(deps, project, task.workdir, task.id);
    if (why) {
      problems.push(`${task.id}'s working copy was kept (${why}): ${task.workdir}; slp clean removes it once it is safe`);
      continue;
    }
    // A task branch with no commits of its own holds nothing worth keeping.
    const own = await git(project.root, ["rev-list", "--count", `${task.baseCommit}..${task.branch}`]);
    if (own.code === 0 && own.stdout.trim() === "0") await git(project.root, ["branch", "-D", task.branch]);
  }
  if (lane.inCheckout) {
    // Only if the checkout is still on this lane's branch; never move the Human elsewhere.
    if ((await currentBranch(project.root)) === lane.branch) {
      const r = await git(project.root, ["checkout", lane.base]);
      if (r.code !== 0) problems.push(`your checkout is still on ${lane.branch}; switch it back with \`git checkout ${lane.base}\` (${r.stderr.trim()})`);
    }
  } else {
    const why = await releaseCopy(deps, project, lane.workdir, lane.id);
    if (why) problems.push(`${lane.id}'s working copy was kept (${why}): ${lane.workdir}; slp clean removes it once it is safe`);
  }
  return problems;
}

/**
 * Uncommitted work in a lane's own working copy. In the Human's checkout,
 * untracked files count only inside the write set (the Human's own files and
 * their tools' caches are not the lane's); on the Human's branch (onBranch),
 * tracked changes do too.
 */
export async function laneChanges(lane: Lane): Promise<string[]> {
  const lines = await statusLines(lane.workdir);
  const path = (line: string) => line.slice(3).split(" -> ").at(-1)!.replace(/^"|"$/g, "");
  if (!lane.inCheckout) return lines.map(path);
  return lines.filter((l) => matches(lane.writeSet, path(l)) || (!l.startsWith("??") && lane.home !== "onBranch")).map(path);
}

/** Uncommitted work anywhere in a lane: its copy and its parallel tasks' copies. */
export async function laneDirt(state: State, lane: Lane): Promise<string[]> {
  const found: string[] = [];
  const own = await laneChanges(lane).catch(() => [] as string[]);
  if (own.length) found.push(`${lane.workdir}: ${own.slice(0, 6).join(", ")}`);
  const copies = [...state.tasks.values()].filter((t) => t.lane === lane.id && t.mode === "parallel" && ["running", "handed-back", "rework"].includes(t.state)).map((t) => t.workdir);
  for (const dir of copies) {
    const dirty = await dirtyPaths(dir).catch(() => [] as string[]);
    if (dirty.length) found.push(`${dir}: ${dirty.slice(0, 6).join(", ")}`);
  }
  return found;
}

/** Drop a lane without landing: seats closed, its branch kept for the record. A queued lane is taken off the queue. */
export async function dropLane(deps: Deps, project: Project, laneId: string, reason: string): Promise<void> {
  const state = fold(await readLedger(deps.env, project.id));
  if (!reason.trim()) throw new SlpError("Say why: --reason \"...\"");
  if (state.queued.has(laneId)) {
    await append(deps.env, project.id, () => ({ kind: "lane-unqueued" as const, lane: laneId, reason }));
    deps.out(`lane ${laneId} taken off the queue`);
    return;
  }
  const lane = state.lanes.get(laneId);
  if (!lane || !lane.open) throw new SlpError(`No open lane ${laneId}`);
  const dirt = await laneDirt(state, lane);
  if (dirt.length) {
    throw new SlpError(`Lane ${laneId} has uncommitted work (${dirt.join("; ")}). Have its Lead get it committed or discarded, then drop it.`);
  }
  // Recorded first, so a crash mid-teardown leaves a closed lane the watcher tidies.
  await append(deps.env, project.id, () => ({ kind: "lane-close" as const, lane: laneId, landed: false, reason, commit: null, overGate: false }));
  const problems = await teardownLane(deps, project, lane, state);
  deps.out(`lane ${laneId} dropped; branch ${lane.branch} kept${problems.length ? `\n${problems.join("\n")}` : ""}`);
}

/** How long a queued lane waits for the lane before it to leave the checkout. */
const QUEUE_SETTLE_MS = 2 * 60_000;

/** A queued lane's turn came (ADR 0018): open it, or say why it cannot and take it off the queue. */
export async function openQueued(deps: Deps, project: Project, queued: EventOf<"lane-queued">, now = Date.now()): Promise<void> {
  const events = await readLedger(deps.env, project.id);
  const state = fold(events);
  // A drop tears its lane down in its own process: while the checkout is
  // still on that lane's branch, wait (a little) for it to be switched back.
  const after = state.lanes.get(queued.after);
  const closed = events.findLast((e) => e.kind === "lane-close" && e.lane === queued.after)?.ts;
  if (after?.inCheckout && after.home !== "onBranch" && closed && now - Date.parse(closed) < QUEUE_SETTLE_MS &&
    (await currentBranch(project.root)) === after.branch) return;
  const to = state.seats.get("sup")?.live ? "sup" : "human";
  try {
    const config = await loadConfig(deps.env);
    const lane = await openLane(deps, project, config, {
      ...queued.input, home: queued.input.home ?? null, carry: queued.input.carry === true, after: null,
    }, queued.lane);
    await sendLetter(deps, project.id, { letter: "NOTICE", from: "slp", to, lane: queued.lane,
      text: `${queued.lane} (${queued.input.title}) opened, now that ${queued.after} is closed: ${lane?.inCheckout ? "in your checkout" : lane?.workdir}.` });
  } catch (error) {
    const why = describe(error);
    await append(deps.env, project.id, () => ({ kind: "lane-unqueued" as const, lane: queued.lane, reason: why }));
    await deps.herdr.notify(`slp: ${queued.lane} could not open`, why.split("\n")[0]!).catch(() => undefined);
    await sendLetter(deps, project.id, { letter: "NOTICE", from: "slp", to, lane: queued.lane,
      text: `${queued.lane} (${queued.input.title}) was waiting for ${queued.after} and could not open; it is off the queue:\n${why}\nOpen it again once settled.` })
      .catch(() => undefined);
  }
}

/** The first queued lane whose wait is over: the lane it waited for is closed and its seats are gone. */
export function queuedReady(state: State): EventOf<"lane-queued"> | null {
  for (const q of state.queued.values()) {
    const after = state.lanes.get(q.after);
    if (after ? after.open || liveSeats(state).some((s) => s.lane === after.id) : state.queued.has(q.after)) continue;
    return q;
  }
  return null;
}
