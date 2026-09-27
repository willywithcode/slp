# Workflow: working with and without slp

Both ways of working follow the same repository rules (`AGENTS.md` and
`docs/WORKFLOW.md` from mustang). slp adds a team on top of them; its own
state lives outside the repository (`~/.slp`), and the repository changes
only through Peers' commits and slp's squash landings.

## Which one to use

| Situation | Use |
| --- | --- |
| A question, a review, a small bounded change, work you want to follow step by step | One agent, no slp |
| Work with a clear outcome you would rather hand off than drive | slp |
| Work that splits into parts that can be built in parallel | slp |
| Work that deserves a second, clean-context look before it lands | slp |

A team costs more agent usage than one session. The Supervisor tells you when
a request is small enough for one session.

## Without slp: one agent

You talk to one agent and it follows `docs/WORKFLOW.md`: read-only requests
change nothing; bounded changes are made, checked and reported; durable work
keeps a plan in `docs/plans/active/`; open policy choices come back to you.

## With slp: the team

```
You ⇄ Supervisor ──open-lane──▶ Lead (lane tab) ──start-task──▶ Peer ─┐
        ▲    ▲                    │  ▲ ◀────────── done (hand-back) ───┘
        │    │                    │  └─ accept / rework / cut
        │    │                    ├──start-review──▶ Reviewer (read-only)
        │    │                    └──report ready──▶ watcher: gate ─┐
        │    └──────────── REPORT (with the gate) ◀────────────────┘
        │    close-lane --land ──▶ watcher: squash onto base (never pushed)
        └── Critic reads each lane once against your own words
```

| Seat | Does | Never |
| --- | --- | --- |
| You | Say what you want; answer dialogs and prompts; decide the concept and holds; push | — |
| Supervisor | Settles the request with you, keeps the concept, opens and closes lanes, answers Leads | Write code, run tests, judge work inside a lane |
| Lead (one per lane, own tab) | Plans the lane, briefs Peers, judges hand-backs, asks for reviews, reports ready | Write code, widen the lane |
| Peer | One task: builds it in its owned paths, commits, hands back with evidence | Push, merge, touch paths it does not own |
| Reviewer | Reads one change (or the lane) with clean context and reports findings | Change anything |
| Critic | Reads a lane once against your words and the concept | Change anything |
| Watcher (code) | Delivers letters, runs gates and landings, reads transcripts, raises incidents, nudges | Answer dialogs, accept work, push |

### 1. Once per machine and account

1. Node.js 22+, Herdr, Claude Code, Codex (and `agy` if you use the flash
   preset); `slp` installed (see README).
2. `slp config` writes `~/.slp/config.json`; adjust launchers, models and
   efforts per role if the defaults are not yours.
3. For each account a seat may use: open that agent once in the repository
   and answer its folder-trust dialog. On Windows, open each Codex account once
   so it sets up its sandbox; until then its Peers ask you to approve every
   command.
4. Repositories that use mustang get the `slp` skill with
   `mustang update --apply`.

### 2. Start

In a Herdr pane, in the repository: `slp start`. The watcher opens below you
and the Supervisor to your right, then introduces itself. `slp start` detects
the project's test command as the gate (`npm test`, `cargo test`, `go test`,
`pytest`, ...); the Supervisor can change it (`slp set-project --gate`).

### 3. Ask for what you want

Talk to the Supervisor as you would to one agent. It asks you what only you
can decide (what the project does, how it behaves) with its recommendation,
and decides the rest itself. It then either says one session is enough, or
opens a lane: an outcome, checkable acceptance, what is out of scope, and a
write set (the paths the lane may change). Your own words go with the lane;
a Critic compares the two once and tells the Supervisor where they may differ.

### 4. How a lane runs

- The first lane works in your checkout on branch `lane/L1-...` (it must be
  clean); later lanes get their own worktree under `~/.slp`.
- The Lead briefs Peers with outcomes, acceptance and owned paths. Tasks in
  the lane's copy run one at a time; `--parallel` tasks get their own copy and
  are merged into the lane when accepted.
- A Peer commits on its branch and hands back: outcome, a summary against
  each acceptance item, the checks it ran, what is left. slp adds the commits,
  the changed files, anything outside its owned paths, and a review hint for
  large changes.
- The Lead judges by the record (`slp diff`, `slp test`) and accepts, sends
  it back with what to change, or cuts it. A review can come first.
- `slp report ready` makes the watcher run the gate; the Supervisor gets the
  report with the result. It closes the lane with `slp close-lane L1 --land`:
  the watcher merges the base in, runs the gate again, and lands one squash
  commit on the base branch. Your checkout returns to the base branch.
- slp holds a landing for you when the lane is high risk (auth, payments,
  migrations, ...) and had no review of the whole lane, or its diff changes
  migrations or adds destructive SQL. The Supervisor shows you why; it lands
  only with your agreement (`--over-risk --reason "the Human agreed: ..."`).

### 5. How letters travel

Every letter is written to the project's ledger before delivery (ADR 0003).
A letter to a seat that is busy, or that shows a startup dialog, waits; the
watcher delivers everything waiting for a seat in one message when it is
free. A seat's first letter carries its introduction and its brief together.

| In `slp status` | Meaning | What to do |
| --- | --- | --- |
| (not listed) | Delivered | Nothing |
| `queued` | Waiting for the seat, or sent from a sandbox | Nothing; the watcher delivers it |
| `relaying` | The watcher is delivering it | Nothing |
| `failed` | Herdr refused it, a dialog was on screen with no watcher, or it was pasted but not submitted | Read the error; resolve it; `slp redeliver <seq>` (a paste left unsent: submit it in that pane instead) |
| `unconfirmed` | No outcome recorded | Check the seat's pane; if missing, `slp redeliver --force <seq>` |

### 6. Your part while the team runs

- **Dialogs and prompts.** Startup dialogs are only yours. Permission
  prompts go to the Supervisor while you are out of the loop (the default):
  it allows what serves the seat's brief and refuses the rest, recorded, and
  a Peer's Lead hears of it. With `"human": { "inLoop": true }` they are
  yours: slp notifies you with the command after 3 minutes.
- **Holds.** Answer the Supervisor when it brings you a held landing.
- **Incidents.** The watch reads the Leads' and Peers' transcripts. What it
  finds is recorded (`slp incidents`); pages (destructive commands) always
  notify you; account problems always reach the Supervisor. Mailing other
  incidents to the Lead or Supervisor is off until you turn on
  `"watch": { "mail": true }` in the config.
- **Do not type into seats' panes** or message them through Herdr: that
  bypasses the ledger, the watch and the team's authority.

### 7. When the watch pings you

| You see | Usually means | Do |
| --- | --- | --- |
| "X needs you" / "X waits on you" | A startup dialog or permission prompt in X's pane | Answer it there; its letters follow |
| "X needs a look" (page) | X ran a destructive command | Read X's pane and the incident; tell the Supervisor what to do |
| "X account problem" | X's account hit a limit or logged out | The Supervisor may `slp move-seat X <launcher>`; or log in again |
| "L1 held for you" | A landing waits for your agreement | Read the reason with the Supervisor; agree or not |
| "L1 landed" | One squash commit on the base branch | Review, then push when you want |
| "letters to X not submitted" | Text sits in X's input box | Press Enter in X's pane if the text is right |

Incidents are readings, not verdicts. Mark them (`slp ack I3 useful|noise`):
the marks are how Jev earns thresholds.

### 8. Optional: Jev

Set `JEV_API_KEY` or `OPENROUTER_API_KEY` before `slp start`. In shadow mode
(default) Jev's readings are recorded and appear as unmailed incidents; mark
them, run `slp calibrate`, and set `"jev": { "mode": "on" }` when the
thresholds look right. Every decision point has a code fallback, so nothing
depends on Jev ([jev-decisions.md](jev-decisions.md)).

### 9. Stop

`slp stop` closes every seat once no lane is open; `slp stop --force` closes
them anyway (the lanes stay open in the record, with their branches). slp
never pushes: push landed work through your usual workflow.

## Example (live run, 2026-09-27, lab repository)

1. You: "a greet(name) function in src/greet.js ... with tests; decide the
   rest yourself, then land it."
2. The Supervisor wrote the concept (adding its own decision: non-strings also
   throw), opened L1 with four checkable acceptance items and a write set of
   three files, and a Critic.
3. The Critic flagged one ambiguity ("only spaces": U+0020 or any
   whitespace?); the Supervisor kept its reading and told the Lead why.
4. The Lead briefed a Codex Peer; its sandbox could not reach Herdr, so its
   hand-back was queued and the watcher relayed it.
5. The Lead checked the diff and ran the tests, accepted, and reported ready;
   the gate ran green; the Supervisor landed it. Main gained one commit,
   `greet(name) in src/greet.js`; the lane's branch and tab were gone.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `NEEDS ATTENTION ... startup dialog` | First run of that agent or account in this folder | Answer the dialog; with a watcher running the seat is introduced afterwards, else `slp intro <seat>` |
| A Codex Peer asks to approve every command, "sandbox setup helper canceled" | Its account's Windows sandbox is not set up | Open that Codex account once and complete the setup |
| `slp ... cannot be loaded because running scripts is disabled` | PowerShell blocks npm's `slp.ps1` | Use `slp.cmd` (seats are told so on Windows) |
| "not a seat of any slp team" | The command runs outside the seat's pane (e.g. a shared daemon) | Codex seats start with `--no-daemon`; restart that seat |
| `queued` letters stay queued | No watcher runs | `slp watch` in a normal terminal |
| "is the Human's command" | A seat tried `start`, `stop`, `watch`, `intro` or `calibrate` | Nothing; those are yours |
| "moved while the lane was being landed" | Someone committed to the base during landing | Land again |
| "has uncommitted work" on drop, or a kept worktree | slp never discards work | Have a Peer commit or discard it, then retry |
