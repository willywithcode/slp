# 0002 Room data lives outside the repository

Date: 2026-09-26

## Status

Accepted

## Context

mustang forbids parallel control-plane state in a repository; repository plans
are the durable record of work. spl still needs a message log, delivery state
and (later) alerts and assessments.

## Decision

All room data lives under `~/.spl/rooms/<room>/` (overridable with
`SPL_HOME`): `room.json`, append-only `events.jsonl`, `messages/`. spl never
writes into the project repository. Agents may link repository plans from
briefs; the plan remains the source of truth for the work itself.

## Alternatives Considered

1. `.spl/` inside the repository: violates mustang's Harness rule.

## Consequences

Positive:

- Repositories stay clean; the log is an audit trail independent of git.

Tradeoffs:

- Room history is per machine and not shared through git.
