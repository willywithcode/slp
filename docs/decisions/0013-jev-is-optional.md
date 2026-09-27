# 0013 slp works fully without Jev

Date: 2026-09-27

## Status

Accepted

## Context

The owner wants Jev used as much as it helps, and slp to work well without
it.

## Decision

- Jev is strictly additive. With no key, the Jev layer is off and every
  decision point in `docs/product/jev-decisions.md` uses its fallback: a
  code rule, the standard chain of command, or the seat's own judgment.
- A Jev error, timeout, `unsure` answer or probability below the threshold
  takes the same fallback. Jev never blocks a message, a seat or a landing.
- No feature may work only with Jev. Every Jev question is listed with its
  fallback before it is built.
- Proof: the test suite runs with Jev disabled and with a fake Jev; every
  phase's live run is done without Jev first; CI never has a key.

## Consequences

- Without Jev, the Lead and Supervisor handle more routine flow decisions
  themselves (more agent usage); nothing stops working.
