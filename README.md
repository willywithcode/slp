# slp

Supervisor / Lead / Peer rooms for coding agents on top of [Herdr](https://herdr.dev).

`slp up` opens a Herdr workspace with a Lead, several Peers and an optional
Supervisor. Agents then talk to each other **only** through `slp`, which
records every message in an append-only room log before delivering it with
`herdr agent prompt`. `slp watch` turns that log plus Herdr's agent states into
reminders for the Supervisor and the human, and can optionally ask Jev to judge
each case's communication.

Status: v0.2 (see `docs/plans/completed/spl-v0.2.md`). Verified by offline
tests on Windows, macOS and Ubuntu (CI) and by live Herdr runs on Windows with
Claude and Codex agents.

## Requirements

- Node.js 22+ on Windows, macOS or Linux
- Herdr on `PATH` (Herdr's Windows support is still beta)
- The agent CLIs you want to run (`claude`, `codex`, ...)

## Install

No clone needed; the built CLI is committed in `dist/`:

```sh
npm install -g https://github.com/willywithcode/slp/archive/refs/heads/main.tar.gz
slp help
```

This puts `slp` on `PATH` (`slp.cmd` on Windows). Use the tarball URL, not
`github:willywithcode/slp`: npm's global install from git links to a temporary
clone that is deleted afterwards. Update with the same command; remove with
`npm uninstall -g slp`. `slp` must be
on `PATH` inside Herdr panes, because the agents run it.

To work on slp itself: clone, `npm install`, `npm test`, `npm run build`
(commit the rebuilt `dist/`; CI checks it matches the sources), `npm link`.

## Use

The full workflow, when to use slp at all, what you do while a room runs,
an alert runbook and troubleshooting are in
[docs/product/workflow.md](docs/product/workflow.md). In short, from a
terminal inside Herdr, in the project directory:

```sh
slp up feature-x --lead claude --peers codex,codex --supervisor claude --watch
```

This creates workspace `slp:feature-x` (Lead top-left, Supervisor below it,
Peers on the right, watcher at the bottom), starts each agent with permission
to run `slp` only (ADR 0004), and tells it to run `slp guide`. If an agent
stops at a first-run dialog (e.g. "trust this folder?"), `slp up` never answers
it for you: it prints what to paste once you have resolved it.

Run rooms with `--watch` when Peers are sandboxed (Codex): a sandbox cannot
reach Herdr, so their messages are queued and the watcher relays them within
seconds. Agents still ask you before running anything other than `slp`.
Then give the task to the Lead in its pane. When done, from a terminal outside
the room: `slp down feature-x`.

| Command | Who | What |
| --- | --- | --- |
| `slp send <peer> [TEXT \| - \| --file PATH]` | Lead | Brief a Peer; opens case `cN` |
| `slp reply <case> <peer> [...]` | Lead | Ask for more on a case; any Peer may be addressed (e.g. a reviewer) and then owes a handback |
| `slp reply <case> <peer> [...] --close` | Lead | Accept and close the case: nobody owes anything |
| `slp handback <case> [...]` | Peer | Report to the Lead on a case the Lead addressed to you |
| `slp redeliver [--force] <seq>` | sender | Retry a message Herdr refused |
| `slp status` / `slp log <case>` | anyone | Cases, who owes what, full history |
| `slp guide [role]` / `slp whoami` | agents | Role protocol / identity |
| `slp watch [--once] [--jev off\|shadow\|alert]` | human | Reminders and optional Jev assessment |
| `slp up ... [--watch]` / `slp down <room> [--force]` | human | Open / close and archive a room |

Identity is the room member whose pane matches `HERDR_PANE_ID` (and
`HERDR_WORKSPACE_ID`), which Herdr injects into every pane; no name an agent
chooses is trusted. Only the Lead briefs and replies; a Peer hands back only on
cases the Lead addressed to it. This guards against mistakes, not against a
hostile local process, which could forge those variables.

## Watch

`slp watch` polls `herdr agent list` (every 10 s, or once with `--once`) and
raises each alert once per trigger (ADR 0005):

| Rule | When |
| --- | --- |
| `peer-idle-without-handback` | a Peer idle/done for 3 min after a brief/reply it has not answered |
| `blocked` | any member on an approval/question dialog for 3 min |
| `lead-no-disposition` | a handback newer than the Lead's last message, Lead idle 10 min |
| `undelivered` | a message without a successful delivery for 3 min |
| `member-gone` | a member's pane no longer hosts its agent kind (an agent whose kind Herdr cannot report is treated as unknown, not as the member) |
| `jev-drift` | `--jev alert` only: Jev confidently judged drift |

Alerts go to the Supervisor pane (if any) and a Herdr notification, and are
retried for up to 5 rounds until one channel succeeds; pending alerts are
delivered before any Jev work. They are reminders, not verdicts. Only one
watcher runs per room (a second one exits with the first one's pid), and a
watcher stops by itself once `slp down` has archived its room (or a new room
reused its name).

Jev is **off** by default. `--jev shadow` records an `assessment` for each
case state (after a handback, and after each later message) without alerting;
`--jev alert` also alerts on confident drift, including a drift recorded
earlier in shadow mode for a case that has not changed since. At most 3 Jev
requests are made per pass, oldest pending case state first. Both need `JEV_API_KEY`;
`JEV_MODEL` (pinned, default `jev-1.13.0`) and `SLP_ALERT_CONFIDENCE`
(0.5–1, default 0.9) are optional. Jev receives the full brief, handback and
later Lead messages of the case. A failed request is recorded as `unknown`
and not retried.

## Data

Everything lives in `~/.slp/rooms/<room>/` (override with `SLP_HOME`), never in
your repository (ADR 0002):

- `room.json`: members, roles, agent kinds and pane IDs
- `events.jsonl`: append-only `brief`, `handback`, `reply`, `delivery`,
  `alert` and `assessment` events
- `messages/`: bodies longer than 6000 characters, delivered as a file pointer
- `watch.json`: the watcher's last observation of each member

Appends are serialized by a lock directory that records its owner; a lock is
only taken over when its owner process is gone. A message Herdr refused is
marked `UNDELIVERED` and can be retried with `slp redeliver <seq>`. A message
from a sender that cannot reach Herdr is `QUEUED` until the watcher relays it.
A message with no recorded outcome (the sender died mid-delivery) is
`UNCONFIRMED`: it may already be in the target pane, so retrying needs
`--force` after checking.
`slp down` moves the room to `rooms/.archive/`.

## Limits

- Messages that bypass `slp` (typing into a pane, calling herdr directly) are
  invisible. The guide forbids it; nothing can enforce it.
- Case states (`awaiting-handback`, `awaiting-lead`, `lead-replied`, `closed`)
  are facts about the last message, not judgments of quality.
- Herdr has no idempotent prompt, so an unconfirmed delivery cannot be
  resolved automatically.

## Develop

```sh
npm run typecheck
npm test             # fake herdr, fake clock and fake fetch; nothing live
npm run build
```

CI runs the same on Windows, macOS and Ubuntu with Node 22 and 24.
