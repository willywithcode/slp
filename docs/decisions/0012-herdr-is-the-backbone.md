# 0012 Herdr is the backbone: seats open and talk only through Herdr

Date: 2026-09-27

## Status

Accepted

## Context

The owner set the core rule: all communication between the roles goes
through Herdr.

## Decision

- **Seats** are opened only with Herdr: `herdr pane split` / `workspace
  create` (with the seat's environment) and `herdr agent start` (kind,
  model, effort). slp never starts an agent process itself.
- **Messages** between roles are delivered only with Herdr (`herdr agent
  prompt`, plus `agent send-keys` for the submission check). The room log
  records each message first; the log is the record, Herdr is the carrier.
  Agents address each other only through `slp` verbs, which deliver through
  Herdr; they never type into another pane or talk through any other
  channel. A sandboxed sender's queued message is still carried by Herdr,
  from the watcher.
- **Identity and state** come from Herdr: a seat is its pane
  (`HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`); working, idle, blocked and gone
  come from Herdr's agent status and events.
- **Layout**: one Herdr workspace per project, one tab per lane.

## Consequences

- Anything Herdr cannot carry or observe is outside slp; features are
  designed around Herdr's CLI and socket API, never around a side channel.
