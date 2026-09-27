# 0004 Agents get permission for `spl` only

Date: 2026-09-26

## Status

Accepted

## Context

The first live run (2026-09-26) showed Claude Code blocking on an approval
dialog for every `spl` call, which stalls the room.

## Decision

`spl up` launches known agent kinds with the narrowest native permission that
lets them run spl:

- Claude Code: `--allowedTools "Bash(spl *)" "Bash(spl.cmd *)"`.
- Codex: `--no-daemon --sandbox workspace-write --add-dir <SPL_HOME>`.
  `--no-daemon` keeps commands in the pane's own process, so they see its
  `HERDR_PANE_ID` (the shared background server runs them with another pane's
  environment). `workspace-write` is Codex's normal mode for trusted projects;
  without it an untrusted folder is read-only, where Codex exits on
  `--add-dir` and a Peer could not edit code anyway. Network stays off.

No other permission is widened; other kinds start with their defaults. A
Codex sandbox still cannot reach Herdr's socket; messages it sends are queued
in the log and relayed by `spl watch` (ADR 0003), so no command has to run
outside the sandbox.

`spl up` never answers a startup dialog: before sending the onboarding prompt
it reads the agent's screen and stops if a folder-trust dialog is shown (Herdr
can report such an agent as ready, and the prompt's Enter would accept it).

## Alternatives Considered

1. Auto-approve dialogs through `herdr agent send-keys`: answers prompts the
   human never saw.
2. Bypass/auto permission modes: far broader than needed.

Live run 2026-09-27 (Codex 0.157, Windows): the original `--add-dir` alone
made Codex exit; commands ran with a foreign `HERDR_PANE_ID`; PowerShell
blocked npm's `spl.ps1` shim (non-Claude agents on Windows are told to use
`spl.cmd`); and a Codex trust dialog was reported as idle. All four are
covered by this decision and by tests.

## Consequences

Positive:

- Rooms run without the human approving each message.

Tradeoffs:

- Unknown kinds may still block on their first `spl` call.
