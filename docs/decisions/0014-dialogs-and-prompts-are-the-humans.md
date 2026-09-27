# 0014 Dialogs and prompts are the Human's

Date: 2026-09-27

## Status

Accepted

## Context

Live runs showed that Herdr may call an agent idle while a startup dialog is
on its screen (Codex's folder-trust screen, whose highlighted answer is
"Trust and continue"), that `herdr agent start` fails with "blocked during
startup" when Claude Code shows its trust dialog, and that a letter's Enter
lands in whatever the pane shows. Automating approvals of agents' commands was
also refused by the owner's permission policy during a lab run.

## Decision

- slp never answers a startup dialog or a permission prompt, and never types
  or presses a key into a pane that shows one. Before every delivery, and
  before the one Enter it may press to submit a paste, slp checks Herdr's
  status and the bottom of the screen.
- A seat that stops at a dialog is still recorded. Its first letter
  (introduction and brief) waits for the watcher, which delivers it once the
  dialog is gone; without a watcher, the Human runs `slp intro <seat>`.
- The Human is told: a Herdr notification at once for a startup dialog, and
  after 3 minutes for any prompt; the seat's superior hears too.
- A letter pasted but not submitted is reported as such, never called
  delivered, and never pasted twice.
- Seats cannot run the Human's commands (`start`, `stop`, `intro`, `watch`,
  `calibrate`).

## Alternatives Considered

1. Pre-trusting slp's worktrees in the agents' configs: it answers the dialog
   on the Human's behalf by other means.
2. Auto-approving a safe list of commands: refused by the owner's policy; the
   agents' own permission settings are the place for that, set by the Human.

## Consequences

Positive:

- Nothing reaches an agent through a screen the Human has not cleared.

Tradeoffs:

- First use of an agent or account in a folder, and Codex accounts without a
  Windows sandbox set up, need the Human before work flows.

## Follow-Up

- Document the one-time setup per account (README, workflow).
