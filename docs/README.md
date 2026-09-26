# Documentation Map

Start with the smallest authoritative surface.

## Current Product

- `WORKFLOW.md`: request shape, planning, judgment, operation, validation, and
  completion.
- `product/`: current product behavior and installation contract.
- `decisions/`: lasting choices future work must inherit.
- `plans/`: one durable working-memory document for work that needs it.
- [`patterns/encoding-invariants.md`](patterns/encoding-invariants.md): turn
  accepted architecture, reliability, security, and quality rules into native
  mechanical validation.
- `templates/`: optional decision, plan, runbook, and Harness-improvement
  structures.

## Consumer-Owned Truth

The consumer's README, product documents, architecture, code, tests, CI,
runtime signals, and application behavior remain authoritative. Harness does
not overwrite those with upstream product assumptions.

## Source Repository

This section describes `mustang`'s own repository layout, not anything
installed into a consumer repo:

- Root `README.md`: install, usage, how it works, development, releases.
- `main.go`, `internal/`: the Go CLI implementation (`target`, `install`,
  `provenance`, `update`, `selfupdate`).
- `scripts/install.sh`, `scripts/install.ps1`: bootstrap installers.
- `.github/workflows/release.yml`: cross-platform release build.
