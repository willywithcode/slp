# 0017 Repository skills in a team

Date: 2026-09-28

## Status

Accepted

## Context

Repositories set up with mustang carry skills (`.claude/skills`,
`.agents/skills`) that every seat discovers on its own. Some fit a role
(`tdd` for a Peer, `code-review` for a Reviewer); some do slp's job or
contradict a role (`herdr` talks to panes directly, `handoff` and
`implement` run work their own way, `smart-commits` may push,
`domain-modeling` writes a CONTEXT.md into the repository).

## Decision

- slp keeps a map of skills to roles (`src/skills.ts`). `slp guide` shows
  each seat the skills its role reaches for, and those no seat uses, limited
  to the skills its working copy has.
- Claude seats are denied the avoided skills outright (`Skill(<name>)` in
  their settings, verified to work). Codex has no per-skill switch; its
  Peers read the list in their guide, and its sandbox and the git shim stop
  the harmful parts (reaching Herdr, pushing).
- A Lead names skills in a brief: `slp start-task --skill tdd` (checked
  against the lane's copy; avoided skills refused).
- Where a skill's steps differ from the role, the role wins: Leads and the
  Supervisor write no files (a durable plan is a Peer's task), and the
  Human's concept lives in `slp context`, not the repository.
- `slp start` notes skill and guidance files that are not committed: lanes
  in their own worktree only see committed files.

## Consequences

- Seats use the repository's skills on purpose; conflicting ones stay out.
- The map must follow mustang's skill set; unknown skills are simply not
  listed.
