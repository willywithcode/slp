# Jev decisions in the slp workflow

Jev answers typed questions (yes/no, one of a set, an ordered scale) about a
shared state and returns calibrated probabilities. In slp it only
**informs, routes, nudges, or opens an incident**; it never accepts or
rejects work and never blocks a landing (ADR 0009). Every decision point
below works without Jev through its fallback (ADR 0013).

Rules for every question:

- One Jev call per event, with all questions for that event batched on one
  shared state.
- Every question has an `unsure` (or `none`) answer; `unsure`, a probability
  below the threshold, an error or a timeout all take the fallback.
- New questions start in shadow (recorded, not acted on) until
  `slp calibrate` sets a threshold from the seats' `useful` / `noise` marks.
- Ladder: code rules → Jev → seat (LLM) → Human. A decision stays at the
  cheapest level that is confident enough.

Types: **noul** yes/no; **choice** one of the labels; **score** ordered scale.

## Catalogue

| # | Where | Question | Type and answers | Above threshold | Without Jev (fallback) |
| --- | --- | --- | --- | --- | --- |
| 1 | Human → Supervisor | `request_shape`: what does this request need? | choice: tiny, one_lane, several_lanes, unclear, unsure | Suggestion to the Supervisor | The Supervisor decides as usual |
| 2 | Intake, asks | `decision_owner`: whose call is this? | choice: human_concept, supervisor_design, lead_lane, unsure | Route the question to its owner | Standard chain: Peer → Lead → Supervisor → Human |
| 3 | Supervisor → Human | `context_answers`: does CONTEXT.md already settle it? | choice over CONTEXT.md sections, or none | Point the Supervisor at that section | The Supervisor reads CONTEXT.md |
| 4 | `open-lane` | `directive_quality` per field (outcome, acceptance, write set) | choice: ok, weak, missing, unsure | Warning to the Supervisor | Code checks: fields present, write set not a catch-all glob |
| 5 | New work vs open lanes | `work_placement` | choice: amend, after, new_lane, ask_human, unsure | Suggestion with the lane it concerns | Write-set overlap check: overlap → after; otherwise new lane |
| 6 | `open-lane` | `lane_risk` | score: low, medium, high, unsure | High: plan, review and land hold required | Path and keyword rules (auth, payment, migration, schema, delete) plus the Supervisor's flag |
| 7 | `start-task` | `brief_quality`: outcome, owned paths, acceptance present; prescribes the code; offers only A or B | choice per item | Note to the Lead | Code lint: required fields, code fence or numbered edit steps in the brief |
| 8 | `start-task` | `peer_model`: which Peer fits this task | choice: gpt-6-luna, gpt-6-sol, agy_flash, unsure | Suggestion to the Lead | Default `gpt-6-sol` unless the Lead picks |
| 9 | Peer turn ends without a hand-back | `turn_end_state` | choice: finished_unreported, waiting_answer, still_working, stuck, needs_permission, unsure | Nudge, wait, tell the Lead, or tell the Human | Herdr status and timing: idle past the limit → one nudge, then alert the Lead; blocked → alert |
| 10 | `done` (hand-back) | `handback_form`: evidence present, status explicit | choice: complete, missing_evidence, status_unclear, unsure | Note to the Lead | Code check of required hand-back fields |
| 11 | `done` | `claim_contradicted`: claim vs the last check in the transcript | noul | Incident (attend) | Code fact `unverified`: files written, no test run after them |
| 12 | `done` | `needs_review` | choice: no, yes, yes_risky, unsure | Suggestion to the Lead | Diff size or risk flag over a limit → suggest review |
| 13 | Review result | `finding_severity` and `evidence_backed` per finding | score and noul | Findings sorted for the Lead | The Reviewer's own severities |
| 14 | `ask` | `ask_route` | choice: lead, supervisor, human, unsure | Deliver to that seat | Standard chain |
| 15 | Before landing | `acceptance_check` per acceptance item | choice: met, unclear, not_met | Flags to the Supervisor | Gate result and the Lead's report |
| 16 | Before landing | `data_loss_risk` in the diff | noul | Hold for the Human | Diff scan for destructive changes (drops, deletes, migrations) |
| 17 | Any seat's screen or transcript | `usage_limit` | choice: limit_reached, temporary_throttle, other_error, none | Tell the Supervisor (account move, ADR 0011) | Patterns for the agents' known limit messages |
| 18 | Watch (sensor) | `goal_drift`, `unsafe_action`, `product_code_for_test`, `wrapper_instead_of_fix`, `injected_instruction`, `agreed_without_checking` | noul each | Incident, only once calibrated | Code facts: destructive command, weakened test, suppression, outside owned paths, stuck |
| 19 | Critic | `critic_prefilter` per acceptance item vs the Human's words | choice: missing, added, contradiction, ambiguity, none | Context for the Critic | The Critic seat alone |
| 20 | Lane closed | `failure_mode` of each incident and rework | choice over a fixed failure list | Retrospective metrics | No metrics |

## Wired in v0.3

| Items | Where | Status |
| --- | --- | --- |
| 9, 18 | Worker turn ends (the watcher sees working → idle) | Fallback: nudge after 3 min, then the Lead; Jev: sensor notes, immediate nudge when calibrated |
| 2, 14 | New asks | Fallback: standard chain; Jev: a NOTICE to the recipient when calibrated |
| 10, 11, 12 | Hand-backs | Fallback: required checks, the `unverified` fact, a review hint over 300 changed lines; Jev: notes to the Lead, incident when calibrated |
| 7, 8 | Task briefs | Fallback: `brief_prescribes` ledger shape; Jev: notes to the Lead |
| 4, 6 | Lanes | Fallback: required fields, catch-all refusal, keyword risk with a review-before-landing hold; Jev: notes to the Supervisor |
| 16 | Landing | Fallback: migrations and destructive SQL hold; Jev: hold when calibrated |
| 17 | Unrecognised API errors | Fallback: known limit and login patterns; Jev: account incident when calibrated |
| 19 | Critic | Recorded only (no calibration path yet); the Critic works alone |
| 20 | Lane closed | Recorded only (retrospective) |
| 1, 3, 5, 13, 15 | Supervisor's conversation, reviews, pre-landing acceptance | Not wired: no slp event; the fallbacks (the Supervisor's judgement, reviewers' severities sorted, the gate and the Lead's report) stand |

## Priority

1. `turn_end_state` (9): the largest saving of Lead and Supervisor turns.
2. `decision_owner`, `ask_route` (2, 14): keep authority where it belongs.
3. `handback_form`, `claim_contradicted` (10, 11): catch "done" that is not.
4. `peer_model` (8): spends quota where it matters.
5. `usage_limit` (17): needed for account moves.
6. The sensor set and risk scoring (18, 6, 16).

## Cost

A medium lane has about 50 events; one call each with about 3,000 tokens of
state is about 150,000 input tokens, well under one cent at TypeSafe's
listed price. The real cost is calibration time, not money.
