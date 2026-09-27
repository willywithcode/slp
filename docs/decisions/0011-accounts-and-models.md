# 0011 Accounts and models per seat, managed by the Supervisor

Date: 2026-09-27

## Status

Accepted

## Context

The owner runs several accounts per agent CLI on this machine: Claude Code
(default login plus `claude-as acc1|acc2`, OAuth tokens kept DPAPI-encrypted
in `~/.secrets`), Codex (`codex-as acc1|acc2|acc3`, separate `auth.json`,
shared sessions and config), and agy (one Google account). The wrappers are
PowerShell profile functions; all Claude accounts share `~/.claude` and all
Codex accounts share `~/.codex/sessions`, so a session can be resumed under
another account.

## Decision

- **Launchers** in `~/.slp/config.json`: a name, the agent kind, the
  seat's environment, and an optional pane preparation. Seats are opened
  through Herdr (ADR 0012): the pane is created with the environment, the
  preparation runs in that pane, then `herdr agent start` starts the agent,
  which inherits it.
  - Codex account: environment only (`CODEX_HOME`, `CODEX_SQLITE_HOME`,
    empty `OPENAI_API_KEY`), exactly what `codex-as` sets; no secret.
  - Claude account: the pane decrypts its own token from
    `~/.secrets/claude-<name>.txt` into `CLAUDE_CODE_OAUTH_TOKEN`, as
    `claude-as` does. The token never passes through slp or Herdr arguments.
  - Each platform declares its own launchers.
- **Models per role** (owner, 2026-09-27):
  - Supervisor: Claude `claude-opus-5-5[1m]`, effort `xhigh`.
  - Lead: Claude `claude-opus-5-5[1m]`, effort `high`.
  - Reviewer: Claude `claude-opus-5-5[1m]`, effort `high`.
  - Peer: Codex `gpt-6-sol` (default) or `gpt-6-luna`, or agy
    `gemini-3.8-flash-high`; the Lead picks per task. Codex accounts rotate
    acc1 → acc2 → acc3.
- **Default accounts**: Supervisor on the default Claude login, Lead on
  `claude-as acc1`, Reviewer on `claude-as acc2`.
- **The Supervisor manages accounts.** When a seat's account hits its usage
  limit (seen by the watch in the seat's screen or transcript), the
  Supervisor is told and may move that seat to another account; slp then
  resumes the same session there. slp never switches accounts on its own.
- The owner accepted that continuing work on another account after one hits
  its limit may conflict with the providers' terms; the decision and its
  risk are theirs.

## Consequences

Positive:

- Load and limits are spread across accounts; a limited seat continues with
  its context intact.
- Different model families per role (Reviewer vs Peer) reduce shared blind
  spots.

Tradeoffs:

- A Claude account's token lives in its seat pane's environment for the
  pane's lifetime. Verified 2026-09-27: environment set with `pane split
  --env` reaches the pane (Codex acc2 logged in); a pane decrypts a Claude
  token (length checked, value never shown).
- agy has no documented multi-account mechanism and no narrow permission
  flag yet; it is used with one account.
