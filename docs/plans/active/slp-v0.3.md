# Execution Plan: slp v0.3 — a full SLP team on Herdr

Date: 2026-09-27

## Status

Active

## Outcome

`slp` runs a coding-agent team the SLP way on Herdr: the Human talks to a
**Supervisor**, which settles intent, opens a **lane** per outcome and answers
Leads; a **Lead** owns each lane, splits it into tasks and accepts or sends
work back; **Peers** do one task each and commit on the lane branch; a
**Reviewer** reads changes with clean context; a **Critic** checks a lane
against the Human's own words. slp carries every message, keeps a durable
record outside the repository, gates landing on the project's tests, lands
accepted lanes into the base branch, and watches Leads and Peers through their
transcripts, with Jev as a calibrated sensor and as a "System 1" for
enumerable flow decisions. slp never judges whether the work is right: that is
always a seat's call or the Human's.

## Context

- v0.2 (`docs/plans/completed/spl-v0.2.md`): rooms, record-before-deliver,
  relay for sandboxed agents, submission check, deterministic watch rules,
  optional Jev case assessment, live-verified with Claude and Codex.
- Owner decisions (2026-09-27): rename to slp (ADR 0006); borrow the ideas of
  mature SLP team tooling, write all text ourselves and cite nothing;
  full team in the first version (Reviewer and Critic included); Jev as sensor
  and loop control; team rules in seat prompts plus the mustang skill; Watcher
  = code + Jev, no LLM seat; Jev via TypeSafe or OpenRouter; Peers commit,
  slp lands (ADRs 0007-0010).
- Feasibility checked: Claude Code accepts `--session-id <uuid>` (transcript
  path known in advance); Codex writes `~/.codex/sessions/**/rollout-*.jsonl`
  whose `session_meta.runtime_workspace_roots` lists `--add-dir` roots, so a
  per-seat marker directory identifies each Peer's transcript.

## Scope

In scope: everything under Approach.

Out of scope: Paseo; a GUI (Herdr panes and CLI only); pushing to remotes;
cross-machine sharing of state; agent kinds other than Claude Code and Codex
(the design keeps kinds as data so others can be added).

## Approach

### Model

- **Project**: one per repository, state in `~/.slp/projects/<id>/`
  (`project.json`, `CONTEXT.md`, event ledger, seats, slots, assessments).
  Seats open in the Human's own Herdr workspace: tab 1 for the Human,
  Supervisor and watcher; one tab per lane (ADR 0012).
- **Ledger**: the existing locked, append-only event log, extended with lane,
  task, ask, letter, incident and assessment events; state is a fold.
- **Roles as data** (`roles.json`): per role its capabilities, allowed
  verbs, default agent kind/model/effort, prompt, and whether it is watched.
- **Seats**: an agent in a Herdr pane with a role, lane/task, and a transcript
  reference; identity by pane as today.
- **Letters**: typed messages (TASK, HANDBACK, REWORK, ASK, ANSWER, REPORT,
  MERGED, INCIDENT, ...) recorded before delivery, held while the seat works,
  batched per seat, relayed for sandboxed senders, submission-checked.
- **Lanes**: outcome, acceptance, out of scope, write set; branch
  `lane/<id>-<slug>`; first lane in the checkout, later lanes in git worktree
  slots; write sets may not overlap; one writer per working copy.
- **Gate**: the project's test command (detected, overridable); runs when a
  Lead reports ready and before landing; a red gate blocks landing unless the
  Supervisor overrides with a reason.
- **Landing**: merge base into the lane, run the gate, squash onto the base
  branch; never push.

### Verbs (`slp <verb>`, permitted by role)

- Supervisor: `open-lane`, `amend-lane`, `close-lane`, `set-project`,
  `message`, `answer`, `status`, `incidents`, `ack`.
- Lead: `plan-tasks`, `start-task`, `start-review`, `accept`, `rework`,
  `cut`, `report`, `ask`, `answer`, `message`, `status`, `incidents`, `ack`.
- Peer, Reviewer: `done`, `ask`. Critic: `findings`.
- Human: `start`, `status`, `incidents`, `calibrate`, `config`, `stop`.

### Watch

- Transcript readers for Claude Code and Codex turn each turn into steps
  (commands, edits, tool results, final words).
- Facts in code: destructive command (page), stuck/repeating, no recovery
  after a failure, weakened test, suppression, unverified success claim, long
  turn, edit outside owned paths; ledger shapes: rework loop, reviews not
  converging, accepted while unfinished, brief that prescribes the code.
- Incident book: routing (Peer → its Lead; Lead, page, or orphan →
  Supervisor), holds (shadow by default, daily budget), `ack`
  useful/noise/unknown. The watched seat never hears.

### Jev

- Sensor: our own question set over views of a turn (actions, work, claim);
  thresholded questions may open incidents, unthresholded ones only record;
  providers TypeSafe (`JEV_API_KEY`) or OpenRouter (`OPENROUTER_API_KEY`).
- `slp calibrate`: per question, separation between useful and noise marks
  and a threshold within a daily budget.
- Loop control ("System 1"): typed flow decisions (e.g. a Peer turn ended
  without a hand-back: wait / nudge / escalate; an ask: Lead / Supervisor /
  Human). Flow only, never acceptance; shadow until calibrated; low
  confidence escalates to the seat above.

### Phases

Each phase: tests first at agreed seams, implement, live run on a disposable
lab repository with Claude and Codex seats, independent review until no
actionable findings, docs and ADRs current.

1. **Foundations**: project state, roles as data, launchers and accounts
   (ADR 0011: per-role model and effort, Codex rotation, Lead picks a Peer's
   model per task), seat launch through the owner's `claude-as`/`codex-as`
   commands, `slp start` (Supervisor seat + watcher), letters and outbox on
   top of v0.2 delivery, verb dispatch with role permissions.
2. **Lanes and tasks**: lane verbs, branches and worktree slots, write-set
   checks, gate detection and runs, landing, asks and answers with reminders.
3. **Reviewer and Critic** seats and their verbs.
4. **Watch v2**: transcript readers, facts, ledger shapes, incident book,
   usage-limit detection routed to the Supervisor, which may move the seat
   to another account (the session is resumed there).
5. **Jev sensor** and `slp calibrate`.
6. **Jev loop control** in shadow, then enforced above calibrated thresholds.
7. **Release**: mustang skill renamed and rewritten as `slp`, workflow docs,
   v0.3.0, mustang release.

## Risks And Recovery

- Scope is large: phases are shippable on their own; each ends green.
- Landing touches the Human's base branch: never push; refuse on a dirty
  checkout; every land is a single squash commit that can be reverted.
- Transcript formats are not public contracts: readers are isolated per
  kind, tested on recorded samples, and degrade to "no facts" rather than
  wrong facts.
- Jev costs money per reading: off without a key, budgets per day, shadow
  first.

## Progress

- [x] 0. Rename spl → slp (ADR 0006); GitHub repository renamed.
- [ ] 1. Foundations
- [ ] 2. Lanes and tasks
- [ ] 3. Reviewer and Critic
- [ ] 4. Watch v2
- [ ] 5. Jev sensor and calibrate
- [ ] 6. Jev loop control
- [ ] 7. Release

## Decisions

- 2026-09-27: Decisions listed under Context; ADRs 0006-0010.
- 2026-09-27: Accounts and models per seat, Supervisor-managed account
  moves on usage limits (ADR 0011).
- 2026-09-27: Owner rule: all communication between roles goes through
  Herdr; seats are opened with `herdr agent start` (ADR 0012).
- 2026-09-27: Seats open in the Human's workspace, one tab per lane.
- 2026-09-27: The local folder is still named `spl` (held open by another
  process); rename when free.

## Validation

- Focused proof: vitest per module with fake Herdr, git in temp repos, fake
  transcripts, fake Jev.
- Integration proof: live lab runs per phase.
- Repository checks: typecheck, tests, build, CI on three platforms.

## Result

Pending.
