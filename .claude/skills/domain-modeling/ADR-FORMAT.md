# ADR Format

If the repo already has a decision-record convention (for example a
`docs/decisions/` directory, a `docs/templates/decision.md` template, or an
equivalent documented elsewhere), use it as-is instead of the layout below:
one decision system per repo, not two. Otherwise, ADRs live in root
`docs/adr/` for a single-context repo; when `CONTEXT-MAP.md` establishes
multiple contexts (see `SKILL.md`'s File structure section), root
`docs/adr/` holds system-wide decisions and each context additionally gets
its own `docs/adr/` next to that context's `CONTEXT.md`, wherever
`CONTEXT-MAP.md` places it — not necessarily under `src/`. Either way,
number sequentially within each such directory: `0001-slug.md`,
`0002-slug.md`, etc., created lazily, only when the first ADR is needed.

## Template

Follow the repo's own decision template if one exists. Otherwise:

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why*, not in filling out sections.

## Optional sections

Only include these when they add genuine value, and only when not already
dictated by the repo's own template. Most ADRs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`): useful when decisions are revisited
- **Considered Options**: only when the rejected alternatives are worth remembering
- **Consequences**: only when non-obvious downstream effects need to be called out

## Numbering

Scan the repo's decision directory (`docs/decisions/`, `docs/adr/`, or
whichever this repo actually uses) for the highest existing number and
increment by one.

## When to offer an ADR

If the repo's own decision system documents when a decision must be
recorded, that policy governs. Otherwise, all three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library: just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it; otherwise someone will suggest GraphQL again in six months.
