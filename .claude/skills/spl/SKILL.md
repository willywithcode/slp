---
name: spl
description: "Coordinate as the Lead, a Peer or the Supervisor of an SPL room. Use when SPL_ROOM is set in the environment, or when a message starts with [SPL brief, [SPL handback, [SPL reply or [SPL alert."
---

# SPL room

An SPL room is a Herdr workspace where a Lead delegates bounded work to Peers
and a Supervisor reviews their communication. The `spl` CLI
(github.com/willywithcode/spl) records every message in a room log outside the
repository and delivers it to the target's pane.

## Join

1. Confirm membership with `spl whoami`. If it fails, you are not in a room:
   stop using this skill.
2. Run `spl guide`. It is the authority for your role's obligations, message
   format and commands; follow it for every message in this room.

## Rules With This Harness

- Reach room members only through `spl`. Do not use the `herdr` skill, `herdr
  agent prompt` or pane input to talk to them: those messages bypass the room
  log and supervision.
- Room data stays in `~/.spl`. Never copy room logs or case state into the
  repository or create parallel task records for them.
- When work spans sessions or several Peers, the Lead keeps one plan in
  `docs/plans/active/` per `docs/WORKFLOW.md` and links it in briefs; the plan,
  not the room log, is the durable record of the work.
- A handback is a completion claim under the Completion Standard in
  `docs/WORKFLOW.md`: outcome, changes, behavior-appropriate evidence and
  unresolved risks. Never report unverified work as complete.
- Supervisor alerts are fact-based reminders, not verdicts on the work.
