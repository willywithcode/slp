# 0001 slp is a standalone TypeScript tool, separate from mustang

Date: 2026-09-26

## Status

Accepted

## Context

The owner wants an SLP workflow on Herdr that works with mustang. mustang's
Harness states it has no task database or orchestration lifecycle, and its
binary only installs guidance files. The runtime needs a long-lived process,
network calls (Jev) and credentials.

## Decision

slp is its own repository and CLI, written in TypeScript for Node.js 22+ (owner
choice, for parity with paseo-supervision), and must run on Windows, macOS and
Ubuntu. mustang ships only the agent-facing `slp` protocol skill.

## Alternatives Considered

1. A `mustang slp` subcommand in Go: contradicts mustang's scope.
2. Go for slp: single binary, but no reuse of the accepted TypeScript Jev code.

## Consequences

Positive:

- Reuses paseo-supervision's Jev contract; one codebase for three platforms.

Tradeoffs:

- Users need Node.js until standalone binaries are produced.

## Follow-Up

- Standalone binaries after the protocol settles.
