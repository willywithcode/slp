# 0009 Watch from transcripts; Jev as sensor and System 1

Date: 2026-09-27

## Status

Accepted

## Decision

- The watch reads each Lead's and Peer's transcript (Claude Code via
  `--session-id`, Codex via a per-seat `--add-dir` marker in its rollout
  metadata) and derives facts in code.
- Findings become incidents routed to whoever answers for the seat (Peer →
  Lead; Lead, pages and orphans → Supervisor); the watched seat never hears.
  Mailing is off (shadow) until the owner turns it on; `ack` marks feed
  calibration.
- Jev is optional (no key, no Jev), reached through TypeSafe or OpenRouter.
  As a sensor, only questions with a calibrated threshold may open
  incidents. As System 1, it makes enumerable flow decisions (nudge, wait,
  escalate, route an ask); never acceptance; low confidence escalates.
