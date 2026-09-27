# slp product overview

Accepted intent from the owner (2026-09-26, extended 2026-09-27): a
Supervisor/Lead/Peer team of coding agents on Herdr, in the spirit of an SLP
workflow, with Jev as an optional sensor and loop control; TypeScript, on
Windows, macOS and Ubuntu; integrated with mustang through its `slp` skill.

## Roles (ADR 0007)

- **Human**: says what they want, owns the concept, answers dialogs and
  prompts, agrees to held landings, pushes.
- **Supervisor**: acts for the Human; settles requests, keeps the concept,
  opens one lane per outcome, answers Leads, lands lanes. Writes no code.
- **Lead** (one per lane): plans the lane, briefs Peers, judges hand-backs,
  asks for reviews, reports the lane ready. Writes no code.
- **Peer**: one task in its owned paths; commits; hands back with evidence.
- **Reviewer**: read-only, clean-context review of a task or a lane.
- **Critic**: reads a lane once against the Human's own words and the concept.
- **Watcher**: code, not a seat; delivery, gates, landings, watch, nudges.

## Communication contract (ADR 0003, 0012)

- Seats talk only through `slp`. Every letter is recorded in the project's
  ledger (`~/.slp/projects/<id>/ledger.jsonl`) before it is delivered with
  `herdr agent prompt`. Seats are opened only with `herdr agent start`.
- A seat is known by its Herdr pane; nothing an agent says about itself is
  trusted.
- Letters to a busy seat, or one showing a dialog, wait for the watcher. slp
  never answers dialogs or prompts (ADR 0014).

## Work contract (ADR 0008, 0015)

- A lane is an outcome with checkable acceptance and a write set, on its own
  branch; one writer per working copy; tasks own paths inside the write set.
- The gate is the project's own test command, run by the watcher.
- Landing is one squash commit on the base branch, on the base the gate
  tested; slp never pushes, never discards uncommitted work, and holds risky
  landings for the Human.

## Watch and Jev (ADR 0009, 0013)

- The watch reads the Leads' and Peers' transcripts and raises incidents,
  routed to whoever answers for the seat; mail is off until the owner turns it
  on; pages and account problems always get through.
- Jev is optional. Every decision point has a code fallback; readings are
  recorded, act only when calibrated and switched on, and never accept work or
  land. Data sent to Jev: the state of the event (briefs, hand-backs, recent
  steps), only with a configured key.

## Platforms

Node.js 22+ on Windows, macOS and Ubuntu; Herdr on `PATH`; Claude Code and
Codex (and `agy`) for the seats.
