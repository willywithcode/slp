---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched and the findings kept as a durable file.
---

Delegation and file-writing are independent: delegating the legwork to a background agent doesn't by itself authorize writing to the repo. Only do step 2 below (writing the file) when the user wants the findings captured durably. If they just want the question answered — even if you delegate the investigation itself to a background agent to keep working in parallel — report the findings back in this conversation instead and skip the write; that's a plain read-only response, not a reason to leave a new file behind.

Spin up a **background agent** to do the investigation, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. If durable capture was requested: write the findings to a single Markdown file, citing each claim's source. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where. Otherwise, report the findings directly instead of writing anything.
