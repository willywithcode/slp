# slp product overview

Accepted intent from the owner (2026-09-26): build a Supervisor/Lead/Peer
(SLP) workflow on Herdr instead of Paseo, integrated with mustang, written in
TypeScript, usable on Windows, macOS and Ubuntu.

## Roles

- **Human**: opens rooms, gives the Lead its task, receives Supervisor output.
- **Lead**: decomposes the task, briefs Peers, dispositions every handback.
- **Peer**: does one bounded brief at a time and hands back with evidence.
- **Supervisor** (optional): reviews room communication, never artifacts;
  reports concerns to the human.

## Communication contract

- Members communicate only through `slp`. A message is recorded in the room
  log first, then delivered to the target's Herdr pane.
- A brief opens a case (`c1`, `c2`, ...). Only the Lead briefs and replies;
  a reply may go to any Peer (e.g. a reviewer), and a Peer hands back only on
  cases the Lead addressed to it.
- The obligations for briefs, handbacks and dispositions are the ones printed
  by `slp guide` (`src/protocol.ts`). They match the Jev rubric accepted in
  paseo-supervision and mustang's Completion Standard.
- A reply either asks for more (the addressed Peer then owes a handback) or,
  with `--close`, accepts and closes the case (nobody owes anything; a later
  handback reopens it). Only an explicit close ends the Lead's obligation.
- Case states describe the last message, never quality.

## Supervision contract (inherited from paseo-supervision)

- Communication supervision, not artifact review or acceptance.
- Silence or elapsed time is a checkpoint, not proof of drift.
- Unknown or low-confidence judgments are silent; absence of alerts is not
  proof of health.
- Data sent to Jev: full brief/handback/reply bodies of the case. Only with a
  configured key.

## Platforms

Node.js 22+ on Windows, macOS and Ubuntu; Herdr on `PATH`.
