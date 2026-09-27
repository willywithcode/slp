# 0005 Watch alert policy

Date: 2026-09-26

## Status

Accepted

## Context

`slp watch` needs defaults for when to alert, where alerts go and whether Jev
runs. The owner chose them on 2026-09-26.

## Decision

- Jev is **off** by default, even when `JEV_API_KEY` is set. It runs only with
  `--jev shadow` (record assessments) or `--jev alert` (also alert).
- Deterministic rules and defaults:
  - peer idle/done without a handback it owes: 3 minutes after delivery;
  - any member blocked on a dialog: 3 minutes;
  - handback not dispositioned while the Lead is idle/done: 10 minutes;
  - message recorded but undelivered: 3 minutes (same bound as blocked);
  - member pane no longer hosts its agent: immediately.
  Durations are measured from the later of the triggering delivery and the
  first observation of the current Herdr state (`state_change_seq`).
- Alerts go to the Supervisor pane when the room has one, and always to a
  Herdr notification. Each alert is recorded as an `alert` event keyed by the
  triggering message seq or Herdr state episode, so it fires once per trigger,
  including across watcher restarts.
- Alerts describe facts and point at `slp log`; they never claim drift.
- A closing reply (`slp reply --close`) ends every obligation on the case; the
  first live run (2026-09-26) showed that treating an "Accepted" reply as a new
  request raised a false `peer-idle-without-handback` alert.
- An alert is recorded before delivery and retried every watch pass (up to 5
  rounds) until the Supervisor prompt or the notification succeeds.
- A member whose pane hosts a different agent kind counts as gone; an agent
  without a reported kind is `unknown` (never attributed to the member).
- One watcher per room, enforced by an owned `watch.lock`; a watcher on
  another host is never displaced by age (its liveness cannot be checked). Pending alerts are
  delivered before any Jev request, and a pass makes at most 3 Jev requests.
- A watcher is bound to one room instance (workspace ID and creation time):
  it stops when that room is archived by `slp down` or replaced by a new room
  with the same name; the log is never recreated for an archived room.
- Under the per-pass Jev budget, the oldest unassessed case state goes first.
  A `jev-drift` alert is raised only if the judged state is still the case's
  latest when the alert is recorded.
- With `--jev`, each case state (latest message seq, once a handback exists)
  is assessed at most once; failures are recorded as `unknown` and not
  retried. `--jev alert` raises `jev-drift` only for a confident drift
  verdict under paseo-supervision's `decision()` gates, and also for a drift
  already recorded (e.g. in shadow mode) for a case state that is still current.

## Alternatives Considered

1. Jev shadow or alert by default: rejected by the owner.
2. Notification only / Supervisor only.

## Consequences

Positive:

- No external data leaves the machine unless explicitly enabled.

Tradeoffs:

- Timing rules can alert on legitimate long silences; they are reminders, not
  verdicts.
