# 0008 Lanes, working copies and landing

Date: 2026-09-27

## Status

Accepted

## Decision

- A lane has an outcome, acceptance, out of scope and a write set; open
  lanes may not overlap in what they write.
- Branch `lane/<id>-<slug>`. Where a lane works is ADR 0018 (it replaces
  "the first lane uses the checkout; later lanes use worktrees").
- One writer per working copy. Peers commit on their lane (or task) branch;
  Leads and the Supervisor never touch git.
- The gate is the project's test command (detected, overridable). It runs
  when a Lead reports ready and before landing; red blocks landing unless the
  Supervisor overrides with a reason.
- Landing merges the base into the lane, runs the gate, then squashes the
  lane onto the base branch as one commit. slp never pushes.
