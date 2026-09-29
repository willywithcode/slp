# slp

A Supervisor, Leads and Peers working on your repository, as coding agents
in your own [Herdr](https://herdr.dev) workspace.

You talk to one agent, the **Supervisor**. It settles with you what the work
should do, writes your answers into the project's concept, and opens one
**lane** per outcome. Each lane gets a **Lead** in its own tab, which briefs
**Peers** (the only seats that write code), judges what they hand back, can
ask a read-only **Reviewer** for a clean-context look, and reports the lane
ready. A **Critic** reads each lane once against your own words. slp runs the
project's tests as the gate and lands a finished lane on your base branch as
one squash commit. It never pushes.

Seats talk only through `slp`: every message is a letter, recorded in the
project's ledger before it is delivered through Herdr. A watcher (code, not a
seat) delivers letters to busy seats, runs gates and landings, reads the
agents' transcripts for trouble, and keeps work moving. Jev, a typed
classifier, is optional: without it every decision point takes a code
fallback.

Status: v0.3. Verified by offline tests on Windows, macOS and Ubuntu (CI) and
by live Herdr runs on Windows with Claude Code and Codex seats.

## Requirements

- Node.js 22+ on Windows, macOS or Linux
- Herdr on `PATH` (Herdr's Windows support is still beta)
- A git repository to work on
- Claude Code (`claude`) for the Supervisor, Leads, Reviewers and Critics;
  Codex (`codex`) and/or `agy` for Peers. Accounts and models per role are
  set in `~/.slp/config.json` (`slp config` prints its path).

## Install

The built CLI is committed in `dist/`:

```sh
npm install -g https://github.com/willywithcode/slp/archive/refs/tags/v0.3.5.tar.gz
slp help
```

Later, `slp update` installs the latest release the same way (`--dry-run`
only reports; a clone linked with `npm link` is fast-forwarded instead).
Restart running teams afterwards (`slp stop`, `slp start`); slp lists them.

This puts `slp` on `PATH` (`slp.cmd` on Windows); the agents run it from their
panes, so it must be on `PATH` inside Herdr. To work on slp itself: clone,
`npm install`, `npm test`, `npm run build` (commit the rebuilt `dist/`; CI
checks it), `npm link`.

## Use

In a Herdr pane, inside your repository:

```sh
slp start
```

The Supervisor opens to your right and the watcher below you. Talk to the
Supervisor in its pane. Each lane opens in its own tab; watch it there or with
`slp status`. When you are done: `slp stop`.

What only you do:

- Answer startup dialogs (folder trust) in any pane. slp never answers them
  and never types into a pane that shows one.
- Permission prompts: by default you are out of the loop, as in seatworks,
  and the Supervisor answers them for you (`slp permit`, each answer
  recorded). Set `"human": { "inLoop": true }` in the config to answer them
  yourself; slp then notifies you with the command.
- Decide what the project does. The Supervisor asks you when it matters and
  keeps your answers in the concept (`~/.slp/projects/<id>/CONTEXT.md`).
- Agree, or not, when slp holds a landing for you (a high-risk lane without a
  lane review, or a diff that could lose stored data).
- Push. slp lands locally and stops there.

Your commands:

| Command | What it does |
| --- | --- |
| `slp start` | Supervisor beside you, watcher below |
| `slp status` | seats, lanes, tasks, open asks, waiting letters, landings |
| `slp incidents`, `slp ack I3 useful\|noise\|unknown` | what the watch found; your marks calibrate Jev |
| `slp calibrate [--dry-run]` | Jev thresholds from the marks |
| `slp intro <seat>` | resend a seat's first letter (after you answered its dialog, if no watcher ran) |
| `slp redeliver <seq> [--force]` | send a letter again |
| `slp watch` | run a watcher yourself (normally `slp start` does) |
| `slp config` | path of the accounts, models, watch and Jev settings |
| `slp update [--dry-run]` | install the latest slp release |
| `slp clean [--force]` | remove working copies slp kept (`--force`: even with uncommitted changes) |
| `slp stop [--force]` | close every seat |

Seats see their own verbs with `slp guide`.

### Where lanes work

A lane works in your checkout, on a new branch `lane/L1-...`, when three
things hold: no other lane is using the checkout, it has no uncommitted
changes to tracked files (untracked files such as editor or engine caches do
not count), and it is on the base branch (`main` unless set otherwise).

Otherwise slp does not quietly make a copy of the repository. It refuses the
lane, notifies you, and gives the Supervisor the reason (for example
` M Assets/ThirdPartyService.cs`, or "in use by lane L1") and these choices:

| Choice | What happens |
| --- | --- |
| `--home onBranch` | the lane works on your current branch as it is, uncommitted changes and all; its commits go straight onto it and landing moves no branch (it runs the gate and checks holds) |
| `--home newBranch --carry` | a lane branch in your checkout that takes your uncommitted changes over; they are committed and land with the lane |
| commit or stash first | then the lane opens as usual |
| `--after L1` | the lane waits in a queue; slp opens it in your checkout when L1 closes (`slp status` lists queued lanes) |
| `--home isolate` | a separate working copy under `~/.slp/projects/<id>/slots/`: a **full checkout of the repository** on disk (for a large project, that is its full size again, plus its build caches) |

The default for every lane is `"lanes": { "home": "auto" }` in the config;
set it to `onBranch`, `newBranch` or `isolate` to always work that way.
Parallel tasks (`--parallel`) also get their own full working copy.

When a lane or task ends, slp removes its copy completely (the folder too).
It keeps a copy only while tracked files in it hold uncommitted work; untracked
files do not keep it. Kept copies show in `slp status`, you are notified, the
watcher tries again every 10 minutes, and `slp clean` removes them
(`--force` discards their changes).

The full workflow, a runbook for what to do when the watch pings you, and
troubleshooting: [docs/product/workflow.md](docs/product/workflow.md).

## Accounts and models

`~/.slp/config.json` (written with defaults on first use) names launchers
(which agent, started how) and, per role, the launchers, model and effort.
The defaults use the plain `claude`, `codex` and `agy` on their logged-in
account, the same on every machine. Several launchers for one role rotate
(e.g. Peers across Codex accounts). A Lead picks a Peer preset per task
(`sol`, `luna`, `flash`). An account that runs out is reported to the
Supervisor, which may move the seat with `slp move-seat <seat> <launcher>`;
the session resumes there.

### Several accounts

A launcher may name a command of your own that picks the account; slp
types it in the seat's shell with its arguments appended, and Herdr
recognises the agent it starts. slp never reads or stores a token: your
command does, the same way on the command line and in a team (ADR 0011).

```json
"launchers": {
  "claude":      { "agent": "claude" },
  "claude-acc1": { "agent": "claude", "command": "claude-as acc1" },
  "codex-acc2":  { "agent": "codex",  "command": "codex-as acc2" }
},
"roles": { "lead": { "use": ["claude-acc1"] }, "peer": { "use": ["codex", "codex-acc2"] } }
```

The config can be the same on every machine; each machine defines its own
`claude-as` and `codex-as`, taking the account first and passing every other
argument to the agent. For example:

- Windows (PowerShell profile), with the token saved once per machine by
  `Read-Host -AsSecureString | ConvertFrom-SecureString | Set-Content "$HOME/.secrets/claude-acc1.txt"`:

  ```powershell
  function claude-as { $acc, $rest = $args
    $t = Get-Content "$HOME/.secrets/claude-$acc.txt" | ConvertTo-SecureString
    $env:CLAUDE_CODE_OAUTH_TOKEN = [Net.NetworkCredential]::new('', $t).Password
    try { & (Get-Command claude -CommandType Application)[0].Source @rest } finally { Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN } }
  ```

- macOS (`~/.zshrc`, token in the Keychain via
  `security add-generic-password -a acc1 -s claude-code -w`) and Ubuntu
  (`~/.bashrc`, token via `secret-tool store --label claude-acc1 service claude-code account acc1`):

  ```sh
  claude-as() { acc=$1; shift
    tok=$(security find-generic-password -a "$acc" -s claude-code -w 2>/dev/null || secret-tool lookup service claude-code account "$acc")
    CLAUDE_CODE_OAUTH_TOKEN=$tok command claude "$@"; }
  ```

- Codex, anywhere: one home per account, logged in once
  (`CODEX_HOME=~/.codex-acc2 codex login`), and
  `codex-as() { acc=$1; shift; CODEX_HOME=~/.codex-$acc command codex "$@"; }`
  (PowerShell: set `$env:CODEX_HOME` around `& codex @rest` the same way).

One-time setup per account: open each agent once in the repository and
answer its folder-trust dialog; on Windows, open each Codex account once so it
can set up its sandbox (until then its Peers' commands fail).

## Permissions

As in seatworks (ADR 0016): each role has what it must never do refused
outright (no push, pull, checkout or forced branch moves; no other agents'
logins, `~/.secrets` or git config; readers write and commit nothing), by
Claude Code settings per role and a `git` shim on every seat's PATH. Codex
seats never ask inside their sandbox. Claude seats run without asking inside
Claude Code's sandbox on macOS and Linux; on Windows, where it does not exist
yet, they ask, with read-only git and test commands allowed.

## Repository skills

In a repository with skills (mustang's, in `.claude/skills` or
`.agents/skills`), each seat's `slp guide` lists the ones its role reaches for
and the ones no seat uses (e.g. `herdr`, `handoff`, `implement`); Claude seats
are denied those outright. A Lead names skills in a brief with
`slp start-task --skill tdd`. Commit the skill files: lanes in their own
worktree only see committed files (ADR 0017).

## Jev (optional)

Put the key in `~/.slp/.env` (outside every repository; on macOS and Linux
`chmod 600` it, or slp refuses it):

```
JEV_API_KEY=...            # TypeSafe
# OPENROUTER_API_KEY=...   # or OpenRouter
```

An environment variable of the same name wins over the file. slp reads the
file for its own processes only; no seat is given it, and Claude seats are
denied reading it. Jev starts in shadow mode
(`"jev": { "mode": "shadow" }`): its readings are recorded and shown as
unmailed incidents that you and the seats mark. `slp calibrate` turns the
marks into thresholds; with `"mode": "on"` a reading acts only above its
threshold. Jev informs, routes, nudges or raises incidents; it never accepts
work or lands anything. See [docs/product/jev-decisions.md](docs/product/jev-decisions.md).

## Design

Decisions are in [docs/decisions](docs/decisions); the v0.3 plan and its
progress in [docs/plans](docs/plans).

License: Apache-2.0.
