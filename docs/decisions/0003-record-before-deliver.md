# 0003 Record before delivery; identity from the Herdr pane

Date: 2026-09-26

## Status

Accepted

## Context

Herdr exposes only terminal text, not structured transcripts, so messages must
be captured at the point they are sent. Agents must not be able to speak for
one another.

## Decision

- Every message is appended to the room log under a lock (gap-free `seq`)
  before delivery; each delivery attempt appends a `delivery` event. A failed
  delivery exits non-zero and is retried only by its sender (`spl redeliver`).
- Herdr has no idempotent prompt, so a message without any recorded outcome is
  *unconfirmed*, not failed: it may already be in the target pane.
  `spl redeliver` retries only refused deliveries unless `--force` is given.
- A sender that cannot reach Herdr at all (an agent sandbox) records the
  message as *queued* when a room watcher is alive; the watcher claims it
  (`relaying`) and delivers it. A relay that stops midway shows as
  unconfirmed, never as queued, so it is not sent twice automatically. A
  resend queued after an earlier delivery is relayed too, and no resend (even
  forced) is accepted while a relay claim is younger than a minute.
- Delivery is confirmed after every prompt: if the target does not start
  working, its input line (the last screen lines) still shows unsent pasted
  text, and it is still idle, Enter is pressed once more (seen live with Claude
  Code and long prompts).
- Message text is read as UTF-8 (BOM stripped) or BOM-marked UTF-16, which
  Windows PowerShell 5.1 writes.
- The lock records its owner (token, pid, host) and is taken over only when
  that process is gone (or, for another host, after 5 minutes); takeovers are
  serialized with releases through an owned guard, and a holder only removes
  its own lock. A release that cannot get the guard leaves the lock in place;
  it becomes reclaimable once the holder exits.
- Appending, and storing long message bodies, never create a room directory:
  writes to an archived room fail.
- The caller's identity is the room member whose pane ID equals
  `HERDR_PANE_ID` (and whose room workspace equals `HERDR_WORKSPACE_ID` when
  set), which Herdr injects into every managed pane. No agent-chosen name is
  trusted. Delivery targets the member's pane ID.

## Alternatives Considered

1. Parse pane output for messages: unreliable (alternate screen, TUI noise).
2. Deliver by Herdr agent name: breaks when the name was never assigned.

## Consequences

Positive:

- Complete, ordered, attributable evidence for supervision.

Tradeoffs:

- Messages that bypass `spl` are invisible; only the guide forbids them.
- Identity prevents mistakes, not a hostile local process: environment
  variables can be forged by anything running as the same user.
- Residual lock risk, accepted: if a process dies inside the millisecond-long
  guarded step and two others clear its guard at the same instant, both may
  proceed. There is no portable atomic compare-and-delete for directories.
