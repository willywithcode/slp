# 0016 Seat permissions after seatworks

Date: 2026-09-27

## Status

Accepted; Claude seats on Windows amended by ADR 0020 (they no longer ask by default). Refines ADR 0004 (agents get permission for slp only) and ADR 0014
(dialogs are the Human's: startup dialogs stay so).

## Context

With only `slp` pre-approved, seats asked the Human for every read, test
and git command, and a team stalled on the Human all day. The owner asked
slp to grant permissions the way seatworks does: seats run without asking
where a sandbox holds them, each role is denied what it must never do, and
while the Human is out of the loop the Supervisor answers the prompts that
remain.

## Decision

- Claude Code seats get a settings file per role (`--settings`,
  `~/.slp/settings/claude-<role>.json`): seatworks' deny lists (no subagents,
  no reading other agents' logins, `~/.secrets` or git config; no push, pull,
  checkout, switch, stash or forced branch moves; readers write no files and
  make no commits or merges) and `slp` allowed.
  - Where Claude Code has its sandbox (macOS, Linux), as seatworks:
    `bypassPermissions` inside a required sandbox (`failIfUnavailable`), with
    slp's home writable.
  - On Windows Claude Code has no sandbox yet ("feature gate off", verified
    2026-09-27), so seats still ask, with read-only git and test commands
    allowed for reading roles.
- Codex seats run as seatworks: `--ask-for-approval never` in
  `workspace-write` with network on. Codex reads rule files only from its
  home, which is the owner's account, so slp's rules are not written there.
- A git shim first on every seat's PATH (`~/.slp/bin/<role>/`) refuses the
  role's denied git subcommands for both agents; git named by full path is
  not held, as in seatworks. slp's own git skips the shim.
- The Human in the loop is a setting, `"human": { "inLoop": false }` by
  default (seatworks' `hitl.on` off). Out of the loop, the watcher passes a
  seat's waiting permission prompt to the Supervisor after 20 seconds with
  the command, and the Supervisor answers with
  `slp permit <seat> allow|deny "why"`: Enter on Claude's highlighted Yes, `y`
  for Codex, Esc to refuse; the answer is recorded (`permit` event), a
  refused seat reads why, and a Peer's Lead is told. In the loop, prompts
  go to the Human as before, now with the command in the notification.
- Never answered by anyone but the Human: startup dialogs, the Supervisor's
  own prompts, screens that cannot be read.

## Consequences

Positive:

- Teams no longer stall on routine commands; the dangerous ones are refused
  before anyone is asked.

Tradeoffs:

- Out of the loop, an agent (the Supervisor) grants permissions to agents;
  each grant is on the record and its Lead hears of it. Set
  `"inLoop": true` to keep them all.
- On Windows the shim runs through a `git.cmd` launcher: cmd.exe expands
  `%NAME%` text inside arguments (a commit message quoting `%PATH%`), as it
  does for every npm `.cmd` wrapper. A seat can commit with `-F <file>`.
- On Windows, Claude seats are not sandboxed, so they still ask for what is
  not pre-allowed; Codex seats need their account's Windows sandbox set up
  once, or their commands fail.
