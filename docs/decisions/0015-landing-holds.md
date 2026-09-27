# 0015 Landing holds for risk

Date: 2026-09-27

## Status

Accepted

## Context

The Jev catalogue (items 6 and 16) asks for a hold before landing risky
lanes, with code fallbacks that work without Jev (ADR 0013). An independent
review also found that landing must pin the base it tested.

## Decision

- Landing pins the base commit, merges exactly that commit into the lane,
  runs the gate, squashes onto it, and moves the base only if it has not moved
  (compare-and-swap); otherwise it refuses and asks to land again.
- The landing is recorded before tidying up, so a crash is finished on
  restart; worktrees with uncommitted work are never removed.
- A lane is high risk when its title or outcome names sensitive ground (auth,
  credentials, payments, billing, migrations, schema, security, deletion) or
  its write set covers such paths. Its directive says so, and its landing is
  held until the lane had a review of the whole lane.
- A diff that changes migrations or adds destructive SQL is held for the
  Human. With Jev on and calibrated, a confident `data_loss_risk` reading also
  holds.
- A hold names the lane commit it held. It is lifted only by the Supervisor
  passing the Human's agreement, for that same commit, after the Human has
  spoken to it since the hold:
  `slp close-lane L --land --over-risk --reason "the Human agreed: ..."`.
  slp copies the Human's own words (from the Supervisor's transcript) into
  the landing commit and notifies the Human of every landing over a hold.
- The gate must leave the working copy clean: a gate that changes tracked
  files did not test the commit that would land.
- A lane review covers the commit it saw; later commits need a new review,
  except merges of the base branch that are provably clean (their tree is
  what `git merge-tree` gives for their parents).
- Deleted source files do not count as data loss (git keeps them; each
  landing is one revertible commit).

## Alternatives Considered

1. Warnings only: a warning to the Supervisor is easy to pass over while the
   Human is away.
2. Blocking without override: the Human must stay in charge of their project.

## Consequences

Positive:

- Risky changes meet the Human before they reach the base branch.

Tradeoffs:

- Keyword rules hold some harmless lanes; the override is one command.
- slp cannot read agreement in free text: a Supervisor that misreports the
  Human's words could still lift a hold. The pinned commit, the recorded
  words in the commit and the notification to the Human make that visible
  and revertible, not impossible.
