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
npm install -g https://github.com/willywithcode/slp/archive/refs/tags/v0.3.1.tar.gz
slp help
```

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
| `slp stop [--force]` | close every seat |

Seats see their own verbs with `slp guide`.

The full workflow, a runbook for what to do when the watch pings you, and
troubleshooting: [docs/product/workflow.md](docs/product/workflow.md).

## Accounts and models

`~/.slp/config.json` (written with defaults on first use) names launchers
(which agent, on which account) and, per role, the launchers, model and
effort. Several launchers for one role rotate (e.g. Peers across Codex
accounts). A Lead picks a Peer preset per task (`sol`, `luna`, `flash`). An
account that runs out is reported to the Supervisor, which may move the seat
with `slp move-seat <seat> <launcher>`; the session resumes there. slp never
reads account secrets: a launcher only names environment variables and a
preparation command that the seat's own shell runs (ADR 0011).

One-time setup per account: open each agent once in the repository and
answer its folder-trust dialog; on Windows, open each Codex account once so it
can set up its sandbox (a Codex seat whose sandbox is not set up asks you to
approve every command).

## Permissions

As in seatworks (ADR 0016): each role has what it must never do refused
outright (no push, pull, checkout or forced branch moves; no other agents'
logins, `~/.secrets` or git config; readers write and commit nothing), by
Claude Code settings per role and a `git` shim on every seat's PATH. Codex
seats never ask inside their sandbox. Claude seats run without asking inside
Claude Code's sandbox on macOS and Linux; on Windows, where it does not exist
yet, they ask, with read-only git and test commands allowed.

## Jev (optional)

Set `JEV_API_KEY` (TypeSafe) or `OPENROUTER_API_KEY` (OpenRouter) in the
environment of the terminal that runs `slp start`. Jev starts in shadow mode
(`"jev": { "mode": "shadow" }`): its readings are recorded and shown as
unmailed incidents that you and the seats mark. `slp calibrate` turns the
marks into thresholds; with `"mode": "on"` a reading acts only above its
threshold. Jev informs, routes, nudges or raises incidents; it never accepts
work or lands anything. See [docs/product/jev-decisions.md](docs/product/jev-decisions.md).

## Design

Decisions are in [docs/decisions](docs/decisions); the v0.3 plan and its
progress in [docs/plans](docs/plans).

License: Apache-2.0.
