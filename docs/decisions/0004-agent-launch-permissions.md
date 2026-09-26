# 0004 Agents get permission for `spl` only

Date: 2026-09-26

## Status

Accepted

## Context

The first live run (2026-09-26) showed Claude Code blocking on an approval
dialog for every `spl` call, which stalls the room.

## Decision

`spl up` launches known agent kinds with the narrowest native permission that
lets them run spl: Claude Code `--allowedTools "Bash(spl *)"`; Codex
`--add-dir <SPL_HOME>` so its sandbox can write the room log. No other
permission is widened; other kinds start with their defaults.

## Alternatives Considered

1. Auto-approve dialogs through `herdr agent send-keys`: answers prompts the
   human never saw.
2. Bypass/auto permission modes: far broader than needed.

## Consequences

Positive:

- Rooms run without the human approving each message.

Tradeoffs:

- Unknown kinds may still block on their first `spl` call.
