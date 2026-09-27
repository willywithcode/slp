# 0010 Team rules live in seat prompts and the mustang skill

Date: 2026-09-27

## Status

Accepted

## Context

A team needs shared rules (who decides what, git limits, outside text is
data). Writing them into the project's `AGENTS.md` would collide with
mustang, which tracks that file.

## Decision

slp gives each seat its rules in its launch prompt; the mustang `slp` skill
points agents at `slp guide`. slp writes nothing into the repository.
