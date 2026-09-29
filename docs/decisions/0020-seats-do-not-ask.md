# 0020 Seats do not ask; the Human hears only what is theirs

Date: 2026-09-29

## Status

Accepted. Amends ADR 0016 (Claude seats on Windows).

## Context

On Windows, Claude Code has no sandbox, so under ADR 0016 Claude seats
(the Supervisor and Leads especially) asked for every command not
pre-allowed, and compound commands such as `cd dir; cmd` asked even when
each part was allowed. Seats stalled for minutes; the Supervisor's own
prompts waited three minutes before the Human heard. The owner wants to
give the idea and answer questions about the work (idea, design,
technology), not permission prompts. Verified 2026-09-28: in
`bypassPermissions` on Windows, Claude Code still enforces `deny` rules.

## Decision

- `"permissions": { "mode": "auto" }` (default): Claude seats run in
  `bypassPermissions` on every platform, held by ADR 0016's deny rules (per
  role; readers and Leads write no files), the git shim, and Claude Code's
  sandbox where it exists. `"ask"` gives the previous behaviour: prompts for
  anything not allowed. Codex seats are unchanged (`-a never`).
- `roles.<role>.allow`: the owner's own allow rules (e.g.
  `"Bash(dotnet build*)"`), merged into the role's settings; a deny rule
  still wins.
- The guide tells seats to run one command at a time from where they are
  (absolute paths, `git -C`, Read/Grep/Glob; never `cd dir; cmd`), and to
  ask only about the work, never for leave to do what their brief covers.
- Prompts that still appear:
  - a known permission prompt goes to the Supervisor after `permitAfterMs`
    while the Human is out of the loop (ADR 0016);
  - the Supervisor's own, and every one with the Human in the loop, reach
    the Human at once;
  - a Yes/No slp does not recognise (a menu with "1. Yes" / "No", or a
    trailing `(y/n)`), seen on a seat's screen even when Herdr calls it
    idle, is reported to the Human and the seat's superior after
    `permitAfterMs`; nobody answers it for the Human;
  - any other prompt after `blockedMs`.
- Timings are config: `watch.permitAfterMs` (20000), `watch.blockedMs`
  (180000), `watch.intervalSeconds` (5, the watcher's default interval).

## Consequences

- Auto mode on Windows has no sandbox under the seats: what holds them is
  the deny rules and the shim, not a filesystem boundary. A Lead could still
  write files through a shell command; the guide forbids it and the Critic,
  Reviewer and gate see the result. Owners who want every command vetted set
  `"mode": "ask"`.
- Nothing here answers any prompt on the Human's behalf that ADR 0014 and
  0016 reserve for them.
