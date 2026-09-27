# 0006 Rename spl to slp

Date: 2026-09-27

## Status

Accepted

## Context

The roles are Supervisor, Lead and Peer, in that order of authority under
the Human. The owner asked for the name to follow that order and for the
tool to grow into a full team in that spirit (see the v0.3 plan).

## Decision

Everything is renamed from `spl` to `slp`: the CLI and package, environment
variables (`SLP_HOME`, `SLP_ROOM`, `SLP_ALERT_CONFIDENCE`), the data
directory (`~/.slp`), message markers (`[SLP brief ...]`), the Herdr
workspace label (`slp:<room>`), the GitHub repository
(`willywithcode/slp`), and the mustang skill. There is no compatibility
alias: the only user is the owner. Historical records keep their names
(`docs/plans/completed/spl-v0.2.md`); data under `~/.spl` is left in place.

## Consequences

Positive:

- The name matches the role order.

Tradeoffs:

- Old rooms under `~/.spl` are not read by `slp`; reinstall is required.
