# Workflow: working with and without slp

Both ways of working follow the same repository rules (`AGENTS.md` and
`docs/WORKFLOW.md` from mustang). slp adds a coordination layer for several
agents on top of them; it never replaces the repository as the source of
truth and never writes into it (ADR 0002).

## Which one to use

| Situation | Use |
| --- | --- |
| A question, a review, a small bounded change, work you want to follow step by step | One agent, no slp |
| Work that splits into independent parts that can run in parallel | slp |
| Work that needs a second agent to review the first one's result | slp |
| Long work you do not want to watch continuously | slp with `--watch` |

slp runs several agents at once, so it costs more agent usage than a single
session. Several Peers editing the same checkout can collide; give each room
its own git worktree (`slp up api --cwd ../repo-api-worktree`) when their
write scopes overlap.

## Without slp: one agent

You talk to one agent (for example Claude Code in a terminal) and it follows
`docs/WORKFLOW.md`:

1. **Read-only request** (question, explanation, review): it inspects only
   what it needs and changes nothing.
2. **Bounded change**: it reads the affected code and its proof, makes the
   smallest change, runs the checks, and reports outcome, changes, evidence
   and remaining risks.
3. **Durable work** (spans sessions, has dependencies, needs recovery): it
   keeps one plan in `docs/plans/active/`, works in verified steps, and moves
   the plan to `docs/plans/completed/` after validation.
4. **Open policy choice**: it stops and asks you.

An agent can start other agents through the `herdr` skill, but those messages
are not logged, nobody watches them, and there is no brief/handback contract.
When you need that, use slp.

## With slp: a room of roles

```
You ──task──▶ Lead ──slp send──────────▶ Peer p1 (does the work)
               ▲  ◀──slp handback──────────┘
               │
               ├──slp reply───────────▶ Peer p2 (e.g. reviews p1's change)
               │  ◀──slp handback──────────┘
               └──slp reply --close ──▶ (case closed, nothing owed)

slp watch ──alerts──▶ Supervisor ──reports──▶ You
```

| Role | Does | Talks to |
| --- | --- | --- |
| You | Give the task, approve commands, answer dialogs, decide | Lead, Supervisor |
| Lead | Plans, briefs Peers, checks every handback, closes cases | Peers (through slp), you |
| Peer | One bounded brief at a time; reports with evidence | Lead (through slp) |
| Supervisor | Reviews the communication, never the artifacts; relays alerts | You |
| Watcher (`slp watch`) | Relays queued messages, raises reminders | Supervisor, Herdr notification |

### 1. Once per machine

1. Node.js 22+, Herdr, and the agent CLIs you use (`claude`, `codex`, ...).
2. `npm install -g https://github.com/willywithcode/slp/archive/refs/heads/main.tar.gz`
3. For repositories that use mustang: `mustang update --apply` brings in the
   `slp` skill, so agents recognise room messages on their own.

### 2. Open a room

From a terminal inside Herdr, in the project directory:

```sh
slp up myroom --watch
# defaults: --lead claude --peers codex,codex --supervisor claude
```

`slp up`:

- creates the Herdr workspace `slp:myroom` (Lead top-left, Supervisor below,
  Peers on the right, watcher at the bottom);
- starts each agent with permission to run `slp` only (ADR 0004); every other
  command still asks you;
- sends each agent a short onboarding message telling it to run `slp guide`.

If a line says `NEEDS ATTENTION`, the agent is waiting for you, usually on a
first-run "trust this folder?" dialog. slp never answers such a dialog.
Answer it in that pane yourself, then paste the onboarding text `slp up`
printed for that agent.

Use `--watch` whenever Peers run in a sandbox (Codex does): a sandbox cannot
reach Herdr, so their messages are queued and the watcher delivers them.

### 3. Give the task to the Lead

Type the task in the Lead's pane, as you would with a single agent. State
the outcome and any limits (for example "do not commit"). For durable work
the Lead keeps the repository plan in `docs/plans/active/` as usual; briefs
link to it.

### 4. How a case runs

Each `slp send` opens a case (`c1`, `c2`, ...). The obligations for each
message are printed by `slp guide`:

| Step | Command | Must contain |
| --- | --- | --- |
| Brief (Lead → Peer) | `slp send p1 - <<'EOF' ... EOF` | Observable outcome, write scope or read-only, constraints, evidence required, when to come back early |
| Handback (Peer → Lead) | `slp handback c1 - <<'EOF' ... EOF` | Outcome, changed paths, evidence (commands and results), complete / missing / failed / unverified, what the Peer still holds |
| Ask for more | `slp reply c1 p2 "..."` | A specific request (evidence, a decision, a review); the addressed Peer then owes a handback |
| Accept and close | `slp reply c1 p1 "..." --close` | The disposition; nobody owes anything afterwards |

"OK", "DONE" or silence never close a case; only `--close` does. A handback on
a closed case reopens it. Long messages go through stdin (`-`); a `--file`
draft belongs in a temporary directory, never in the repository.

Case states in `slp status`:

| State | Meaning | Next |
| --- | --- | --- |
| `awaiting-handback` | A Peer owes a report | The Peer works |
| `awaiting-lead` | A handback waits for a disposition | The Lead replies or closes |
| `lead-replied` | The Lead asked for more | The addressed Peer works |
| `closed` | Accepted | Nothing |

### 5. How messages travel

Every message is written to the room log (`~/.slp/rooms/<room>/`) before it is
delivered to the target's pane (ADR 0003). If the target does not start
working and still shows unsent pasted text, slp presses Enter once more.

| Mark in `slp status` | Meaning | What to do |
| --- | --- | --- |
| (none) | Delivered | Nothing |
| `QUEUED` | The sender could not reach Herdr (sandbox) | Nothing; the watcher delivers it within seconds |
| `UNDELIVERED` | Herdr refused it (e.g. the target is on a dialog) | Resolve the cause; the sender runs `slp redeliver <seq>` |
| `UNCONFIRMED` | No outcome recorded (a sender or relay stopped midway) | Check the target's pane; only if the message is missing, the sender runs `slp redeliver --force <seq>` |

### 6. Your part while the room runs

- **Approve or refuse commands** in the agents' panes. Agents may run `slp`
  freely; everything else (tests, git, file edits) asks you.
- **Answer dialogs** only you should answer (trust, permissions, questions).
- **Read alerts.** The watcher checks every 10 seconds and sends each alert
  once to the Supervisor pane and as a Herdr notification (retried up to 5
  times if both fail):

| Alert | After | Usually means | Do |
| --- | --- | --- | --- |
| `blocked` | 3 min on a dialog | An agent waits for your approval | Answer it in that pane |
| `peer-idle-without-handback` | 3 min idle after a brief/reply | The Peer stopped without reporting | Read `slp log <case>`; ask the Lead to follow up |
| `lead-no-disposition` | 10 min Lead idle after a handback | A handback was not dispositioned | Nudge the Lead |
| `undelivered` | 3 min | A message did not arrive (or a queued one was not relayed) | See the table in step 5; check that `slp watch` runs |
| `member-gone` | immediately | An agent exited or another program took its pane | Restart the agent or close the room |
| `jev-drift` | `--jev alert` only | A model judged the communication off-protocol | Review `slp log <case>`; it is a judgment, not proof |

Alerts are reminders, not verdicts; no alert does not prove all is well.

- **Do not type into a Peer's pane** or message members through Herdr
  directly: those messages bypass the log and supervision. Talk to the Lead.
- **Inspect at any time:** `slp status --room myroom`, `slp log c1 --room myroom`.

### 7. Optional: Jev

`slp watch` runs the deterministic rules only. `--jev shadow` also records a
Jev assessment of each case state (needs `JEV_API_KEY`; the full case messages
are sent to TypeSafe); `--jev alert` additionally raises `jev-drift`. Start
with shadow and compare its judgments with your own before relying on alerts.
To use it with a `--watch` room, stop that watcher and run
`slp watch --room myroom --jev shadow` in a terminal that has the key.

### 8. Close the room

From a terminal outside the room: `slp down myroom`. It closes the workspace
(agents and watcher included) and moves the room data to
`~/.slp/rooms/.archive/`. If the workspace is already gone,
`slp down myroom --force` archives the room anyway. Commit the work itself
through your normal repository workflow; slp does not commit.

## Example: fixing a bug with review

Observed in a live run (2026-09-27, `lab7`):

1. You: "Fix the failing tests in `src/cart.js`; p1 fixes, p2 reviews
   read-only; verify and close; do not commit."
2. Lead → p1, brief `c1`: outcome "`npm test` passes", write scope
   `src/cart.js` only (no test edits, no commit), constraints (minimal
   change, same exports), required evidence.
3. p1 (Codex, sandboxed) fixes one line and hands back outcome, changed
   path, `npm test` result and root cause. Its message is queued and relayed
   by the watcher in 9 s.
4. Lead → p2, reply on `c1`: review the change read-only, including edge
   cases.
5. p2 hands back "request changes": a missing `quantity` now gives `NaN`;
   suggests defaulting to 1 and adding tests.
6. Lead decides and says why: missing quantity is not a documented input and
   test edits were forbidden, so it accepts the fix as is, flags the edge case
   to you as an open question, verifies `npm test` and `git diff` itself, and
   closes with `slp reply c1 p2 "..." --close`.
7. Total: about two minutes, no alerts, the repository changed by exactly the
   one-line fix.

In an earlier run, p2 first answered only "approve" with no evidence; the Lead
replied asking for it before closing. Both runs show the contract at work: a
review can disagree, and every handback gets an explicit, reasoned
disposition.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `NEEDS ATTENTION ... trust` on `slp up` | First run in this folder | Answer the dialog, paste the printed onboarding text |
| `NEEDS ATTENTION ... agent_pane_busy` | Another program holds the pane | slp retries and moves to a new pane; if it still fails, start the agent in that pane yourself |
| `slp ... cannot be loaded because running scripts is disabled` | PowerShell blocks npm's `slp.ps1` | Use `slp.cmd` (agents are told this on Windows) |
| An agent says "not a member of any SLP room" | Its commands run elsewhere (e.g. Codex's shared daemon) | Rooms start Codex with `--no-daemon`; restart the agent that way |
| A message sits as `[Pasted text ...]` in the Lead's input | The agent ignored Enter | slp presses Enter once more; press it yourself if it remains |
| `QUEUED` does not clear | No watcher is running | `slp watch --room myroom` in a normal terminal |
| `Room ... is already watched by pid N` | A watcher already runs | Use that one, or stop it first |
| `Timed out waiting for room lock` | Another slp process holds the log briefly or hung | Retry; a lock whose owner died is reclaimed automatically |
