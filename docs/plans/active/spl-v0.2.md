# Execution Plan: spl v0.2 — live-verified rooms, watch, Jev, mustang skill

Date: 2026-09-26

## Status

Active (implementation and verification complete; awaiting owner review and
commit)

## Outcome

A human can run `spl up`, give a task to the Lead, and get:

- messages between Lead and Peers recorded and delivered through `spl`;
- `spl watch` raising deterministic alerts (peer finished without handback,
  peer blocked, handback not dispositioned, undelivered message, member gone)
  to the Supervisor pane or a Herdr notification;
- optional Jev assessment of each case (shadow by default, alert opt-in),
  restart-safe because every alert/assessment is recorded in the room log;
- `spl down` to close a room it created;
- the protocol available to agents in any repo through a mustang `spl` skill;
- CI proving the package on Windows, macOS and Ubuntu.

## Context

- MVP: `src/` (room, log, cases, herdr wrapper, protocol, commands, cli).
- Jev contract and decision gates: `../paseo-supervision/server/jev.ts`
  (accepted there; ported, not reinvented).
- Herdr 0.9.1-preview CLI: `agent list/get/prompt/start`, `pane split/run`,
  `workspace create/close`, `notification show`. JSON on stdout, JSON error on
  stderr with exit 1.
- mustang (`../harness-core`): payload skills live in `.agents/skills/<name>/`;
  Harness forbids repository control-plane state, so room data stays in `~/.spl`.

## Scope

In scope: phases below.

Out of scope: standalone binaries without Node (after protocol settles);
parsing terminal text for messages; any Paseo dependency; releasing or
tagging mustang; committing (left to the human).

## Approach

1. **Live smoke test of the MVP** with real Herdr (1 lead + 1 peer), fix what
   breaks, close only the workspace this run created.
2. **`spl watch` deterministic rules.** Pure `evaluate(snapshot) -> Alert[]`
   plus a polling driver (`herdr agent list`). Alerts recorded as `alert`
   events, deduplicated by key, so restarts do not repeat them.
3. **Jev.** Port questions/validation/decision. Evidence per case from the log:
   brief, latest handback, replies after it (explicit case IDs remove the
   chronology ambiguity Paseo had). Record `assessment` events; `--jev
   off|shadow|alert`, default off (ADR 0005).
4. **`spl down`** closes the recorded workspace and archives the room.
   `spl up --watch` starts the watcher in its own pane.
5. **mustang skill** `spl` + decision record in harness-core, native checks.
6. **CI** matrix: ubuntu/macos/windows x Node 22/24: typecheck, test, build.
7. **Final live run**: brief -> handback -> reply, a watch rule firing, down.

Each phase loops: implement -> typecheck/test -> independent review -> fix ->
re-review until no actionable findings.

## Risks And Recovery

- Live tests start real agents in the user's Herdr session. Use a dedicated
  room/workspace, `--no-focus`, and close only that workspace afterwards.
- `npm link` changes the global npm bin dir. Recovery: `npm unlink -g spl`.
- Jev sends full message bodies to TypeSafe: off by default (ADR 0005).

## Progress

- [x] 1. Live smoke test (2026-09-26). Run 1: both Claude agents blocked on
  the approval dialog for `spl guide` -> ADR 0004 launch args. Run 2 (room
  `trial`, lead+peer claude, cwd paseo-supervision): onboarding, brief via
  stdin, handback with file:line evidence, lead verification and reply `c1`
  all recorded and delivered (seq 1-5, no undelivered); target repo unchanged
  (`git status` clean); workspace wG closed.
- [x] 1b. Adopted mustang (`mustang init`, 0.11.0): product overview and
  ADRs 0001-0004 record accepted intent.
- [x] 2. watch: deterministic rules (tdd at the two agreed seams:
  `evaluate()` and `spl watch --once`). Found and fixed on the way: a peer
  addressed by a reply could not hand back (MVP bug).
- [x] 2b. Review round 1 (independent spec reviewer + Codex): 12 distinct
  findings, all reproduced with a failing test first, then fixed: lock
  takeover of live/fresh locks, torn tail swallowing the next event,
  SPL_AGENT impersonation, alerts lost after failed delivery, duplicate
  redelivery of unconfirmed messages, replacement agent in a member pane,
  last-message-only peer rule, racing `spl up`, null state_change_seq key
  collapse, stale peer in status, README/overview handback contract.
- [x] 3. watch: Jev (ported gates; `--jev off|shadow|alert`, default off).
- [x] 4. down / up --watch
- [x] 5. mustang skill: `harness-core/.agents/skills/spl/` + skills-guide
  entries (JSON blocks validated). No ADR in harness-core: its
  docs/decisions ships to every consumer; ADR 0001 here records it.
  Not run: harness-core `go vet`/`go test` (Go is not installed here).
- [x] 6. CI matrix (`.github/workflows/ci.yml`; not yet run on GitHub).
- [x] 2c. Review rounds 2-4 (same two reviewers): 7 + 7 + 2 findings, each
  reproduced by a failing test where deterministic, then fixed (Jev ordering,
  budget fairness and stale drift alerts; one watcher per room; room-instance
  binding under the log lock; guard ownership and release; busy-spin in
  acquireLock found by a new test). Round 4: spec reviewer reports no
  actionable findings; Codex confirmed the final two fixes, and its last
  residual (down racing an in-flight append) was closed by holding the log
  lock across the archive move.
- [x] 7. Final live run (2026-09-26, rooms `final` and `final2`, Claude lead,
  peer and supervisor, `--watch`, cwd paseo-supervision, read-only tasks):
  briefs, handbacks and replies recorded and delivered; a deliberate
  no-handback drill raised `peer-idle-without-handback` for c2 after 3 min,
  delivered to the Supervisor pane and as a Herdr notification. The same run
  exposed a false alert for a case the Lead had accepted, fixed with
  `spl reply --close` (tests first). Room `final2` then used `--close`; no
  alert after 5 min and the Peer did not reopen the case. `spl down` closed
  the workspace (watcher included) and archived the room; `--force` path
  verified after the workspace was already gone. paseo-supervision stayed
  unchanged (`git status` clean).

## Decisions

- 2026-09-26: Owner asked to use mustang's workflow for spl: plans here,
  product/decisions under docs/, `tdd` at agreed seams, `code-review` loop.
- 2026-09-26: Owner chose watch policy (ADR 0005) and the tdd seams:
  (1) pure `evaluate(snapshot)` -> alerts; (2) `spl watch --once` with fake
  herdr, fetch and clock, observing log events and prompts.
- 2026-09-26: Jev assesses each case state once (latest message seq after a
  handback); no delayed re-assessment, since `lead-no-disposition` covers
  timing. Failed requests are recorded as `unknown` and not retried.
- 2026-09-26: TypeScript on Node 22+ for parity with paseo-supervision and one
  codebase for Windows/macOS/Ubuntu.
- 2026-09-26: Deliver by pane ID (identity key; works when the herdr agent
  name was never assigned).

## Validation

- Focused proof: vitest with a fake herdr CLI and fake clock/fetch.
- Integration proof: live Herdr runs (phases 1 and 7).
- Repository-required checks: `npm run typecheck`, `npm test`, `npm run build`;
  harness-core `go vet ./...`, `go test ./...`.

## Result

- 78 offline tests (7 files), strict typecheck and build pass on Windows.
- Live Herdr runs verified rooms, messaging, watch alerts, `--close` and
  `spl down`.
- Not verified: CI on GitHub (workflow added, never run), macOS/Ubuntu
  execution, Codex as a peer kind (launch args untested live), Jev against the
  real TypeSafe API (no key used; fake fetch only), harness-core `go test`
  (Go not installed).
- Follow-up: standalone binaries; a Codex-peer live run; a shadow-mode Jev
  trial with an owner-provided key.
