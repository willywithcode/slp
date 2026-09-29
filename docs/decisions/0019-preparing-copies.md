# 0019 Preparing new working copies

Date: 2026-09-29

## Status

Accepted

## Context

A worktree made from git has no git-ignored files (local settings, keys a
build needs) and no checked-out submodules, so a Peer starting in one fails
on its first build. Seatworks prepares its copies; slp did not.

## Decision

- Before the seat of a new copy starts (an `isolate` lane or a `--parallel`
  task), slp copies in the files that are both git-ignored and named by the
  project's `.worktreeinclude` (the file Claude Code, Codex and Conductor
  read), then runs the config's `lanes.setup` command there (for example
  `git submodule update --init --recursive`), bounded by the gate timeout,
  with the seats' git shim off its PATH.
- How it went goes to the Lead: in its DIRECTIVE for a lane copy, in
  `slp start-task`'s output for a task copy. A failed setup does not stop the
  seat; the Lead decides.
- Setup never runs in the Human's checkout.
- A write set that reaches into a submodule gets a warning (on open-lane and
  amend-lane, and in the directive): commits there belong to the
  submodule's repository and do not land with the squash. A repository with
  submodules and no setup gets a hint to set one.

## Consequences

`lanes.setup` is global (the owner's config); a command that must differ per
project belongs in a script the repository provides.
