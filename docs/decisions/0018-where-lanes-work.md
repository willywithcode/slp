# 0018 Where lanes work

Date: 2026-09-29

## Status

Accepted. Amends ADR 0008 (working copies).

## Context

Up to v0.3.5, a lane took the Human's checkout when it was clean and on
base, and otherwise got a git worktree, without saying so. For large
repositories (a Unity project with a Library of many GB) each worktree is a
full copy, made because an editor touched one file. Worktrees were left
behind when untracked tool files (`.utmp`, `Library`) sat in them. The owner
asked for seatworks' approach: a standing order for where lanes work, never
a silent copy, a queue, and thorough cleanup.

## Decision

- `lanes.home` in the config, overridable per lane with `slp open-lane
  --home`: `auto` (default), `newBranch`, `onBranch`, `isolate`.
  - `newBranch`: the checkout, on `lane/<id>-<slug>` from base. Refused over
    uncommitted tracked changes unless `--carry`, which takes them into the
    lane (recorded; the Lead is told to have them committed; they land with
    it).
  - `onBranch`: the checkout, on the Human's current branch, as it is. The
    lane's commits go onto that branch. Landing runs the gate and the holds
    and records the lane landed at the branch's tip; it moves, merges and
    deletes nothing. Peers commit only paths in the write set.
  - `isolate`: a worktree under `~/.slp/projects/<id>/slots/`.
  - `auto`: `newBranch` when the checkout is free, clean (tracked files) and
    on base. Otherwise refused, with the concrete reason (porcelain lines,
    the branch, or the lane holding the checkout) and the choices; the
    Human is notified. slp never picks `isolate` on its own.
- `--after L1` queues a lane (`lane-queued`, keeping its id). The watcher
  opens it once L1 is closed and its seats are gone, with the same rules;
  if it cannot open then, it leaves the queue (`lane-unqueued`) and the
  Supervisor and Human get the reason. A queued lane can be dropped.
- In the checkout, untracked files count as the lane's uncommitted work only
  inside its write set; on the Human's branch, tracked ones too.
- Removing a copy (seatworks' release): detach, `git worktree remove`, then
  delete the folder if git left it. A copy is kept only while tracked files
  hold uncommitted changes, or if the folder cannot be deleted. Kept copies
  are recorded (`slot-kept`, `slot-cleared`), shown in `slp status`, reported
  to the Human, tried again by the watcher every 10 minutes, and removed by
  the Human's `slp clean` (`--force` discards changes; it also removes
  folders under slots that no open lane or task uses).

## Consequences

- The Supervisor must settle a refused lane with the Human; a lane never
  costs a full copy of the repository without their say.
- `onBranch` shares the checkout with the Human's own edits: a Peer's
  careless `git add -A` would commit them. The directive says so; the risk
  is the Human's choice.
