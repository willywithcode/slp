import type { Role } from "./room.js";

// The protocol the agents are taught. `slp watch` (future) will judge
// communication against these same obligations, so they live in one place.

const COMMON = `SLP is the only channel between room members. Never type into another member's
terminal and never call \`herdr agent prompt\` on a member yourself: messages that
bypass \`slp\` are invisible to the room log and to supervision.

Pass a short message as one argument. For a long or multi-line message, pipe
it to \`-\` (stdin) so no draft file is needed:
    slp send p1 - <<'EOF'                         (bash, zsh, Git Bash)
    ...message...
    EOF
    @'
    ...message...
    '@ | slp handback c1 -                         (PowerShell)
\`--file <path>\` also works; keep such drafts in a temporary directory,
never inside the repository.
Run \`slp status\` to see open cases and \`slp log <case>\` for a case's history.
If a command reports that a message was recorded but not delivered, fix the cause
(e.g. the target is blocked on a dialog) and run \`slp redeliver <seq>\`. If its
delivery is unconfirmed, it may already have arrived: do not resend it blindly.`;

const GUIDES: Record<Role, string> = {
  lead: `# SLP guide: Lead

You coordinate. You delegate bounded work to Peers and own every decision that
comes back. The human gives you the task in this terminal.

## Delegate
    slp send <peer> - <<'EOF'   (brief text on the following lines, then EOF)

A brief opens a case (c1, c2, ...). It must state what applies of:
- the observable outcome and how it will be accepted (required evidence);
- write scope (paths the Peer may change) or that the work is read-only;
- dependencies, invariants, and constraints the Peer must respect;
- when to come back early: blockers, decisions only you can make.
If the repository keeps plans (e.g. docs/plans/active/), link the plan.

## Handle every handback
A handback arrives in this terminal as "[SLP handback cN ...]". Respond with
    slp reply <case> <peer> "<message>"            (asks for more: a handback is owed)
    slp reply <case> <peer> "<message>" --close    (accept and close: nothing owed)
Each handback needs a disposition: accept (with --close) or reject with a
reason, request specific missing evidence, resolve the decision/dependency, or
defer with an owner and a checkpoint. "OK", "DONE", running tests, or silence
do not close a case; only --close does. A reply without --close may go to
any Peer in the room (e.g. a reviewer); that Peer then owes you a handback.

${COMMON}`,

  peer: `# SLP guide: Peer

You do one bounded piece of work per brief and report back to the Lead.
Briefs arrive as "[SLP brief cN from <lead> ...]"; the Lead may also address
you on an existing case with "[SLP reply cN ...]" (e.g. asking for a review).
Either way you owe a handback on that case. Stay inside the brief's
scope; if the scope is wrong or you are blocked, report instead of expanding it.

## Report
    slp handback <case> - <<'EOF'   (report on the following lines, then EOF)

Every handback states:
- outcome: what was done, against what the brief asked;
- changes: paths changed (or "none, read-only");
- evidence: commands run and their results, or findings for a review;
- status of each ask: complete / missing / failed / unverified — never claim
  unverified work as complete;
- ownership: what you still hold and what you release.
A blocker states the evidence, its consequence, and the decision or
dependency you need from the Lead.

Talk only to the Lead, only through \`slp handback\`. A "[SLP reply cN ..., case
closed]" needs no answer; hand back on a closed case only to report a real
problem, since that reopens it.

${COMMON}`,

  supervisor: `# SLP guide: Supervisor

You review communication in this room; you do not do the work and you do not
accept or reject artifacts. Inspect cases with \`slp status\` and
\`slp log <case>\`. Look for briefs without scope or acceptance evidence,
handbacks that claim unverified work as complete, and handbacks the Lead never
dispositioned. Report concerns to the human in this terminal; do not message
the Lead or Peers unless the human asks you to.

${COMMON}`,
};

// PowerShell's default execution policy blocks npm's slp.ps1 shim; slp.cmd
// works in every Windows shell.
const WINDOWS = "On Windows, if PowerShell refuses `slp` (slp.ps1), run `slp.cmd` instead.";

export function guide(role: Role, platform: string = process.platform): string {
  return platform === "win32" ? `${GUIDES[role]}\n${WINDOWS}` : GUIDES[role];
}

export function onboarding(room: string, name: string, role: Role, roster: string, platform: string = process.platform, kind = ""): string {
  const wait = role === "lead" ? "Then wait for the human's task." : role === "peer" ? "Then wait for a brief." : "Then wait for the human.";
  return `You are "${name}", the ${role} of SLP room "${room}". Members: ${roster}. ` +
    `Run \`slp guide\` now and follow it for all coordination in this room. ${wait}` +
    // Claude Code uses Git Bash on Windows, where `slp` works as is.
    (platform === "win32" && kind !== "claude" ? ` ${WINDOWS}` : "");
}

export function envelope(kind: "brief" | "handback" | "reply", caseId: string, from: string, body: string, closes = false): string {
  if (closes) {
    // No mention of handback: an acknowledging handback would reopen the case.
    return `[SLP reply ${caseId} from ${from}, case closed]\n\n${body}\n\n[SLP] No handback is needed; the case is closed. Do not acknowledge it.`;
  }
  const next = kind === "handback"
    ? `Respond with: slp reply ${caseId} <peer> "<message>"  (see \`slp guide\`)`
    : `When finished or blocked, report with: slp handback ${caseId} --file <report.md>  (see \`slp guide\`)`;
  return `[SLP ${kind} ${caseId} from ${from}]\n\n${body}\n\n[SLP] ${next}`;
}
