# 0007 SLP roles and authority

Date: 2026-09-27

## Status

Accepted

## Context

v0.2 named its monitoring agent "Supervisor", which the owner expected to be
the seat that decides for them. Mature SLP team practice puts a Supervisor
between the Human and the Leads, and a separate Watcher beside the work.

## Decision

- Human: owns the concept (what the project does and how it behaves), kept
  in the project's `CONTEXT.md` outside the repository.
- Supervisor: acts for the Human; settles intent, opens, amends and closes
  lanes, answers Leads, decides priority, design, stack, tests and process.
  Never writes code, reads source, runs git or accepts work.
- Lead: owns one lane; splits it into tasks, briefs Peers, accepts, reworks
  or cuts, reports the lane ready. Never writes code or touches git.
- Peer: one task inside its owned paths; commits on its branch.
- Reviewer: read-only review of one change with clean context.
- Critic: reads a lane once against the Human's words and `CONTEXT.md`.
- Watcher: code and Jev, not a seat; reports to whoever answers for the
  watched seat, never to the watched seat.
- slp runs the team and never judges the work. Borrowed practice is used
  for its ideas only; all text is written for slp.

## Consequences

- The v0.2 "Supervisor" role becomes the Watcher; alerts about Peers go to
  their Lead.
