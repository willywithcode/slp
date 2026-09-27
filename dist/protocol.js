// The protocol the agents are taught. `spl watch` (future) will judge
// communication against these same obligations, so they live in one place.
const COMMON = `SPL is the only channel between room members. Never type into another member's
terminal and never call \`herdr agent prompt\` on a member yourself: messages that
bypass \`spl\` are invisible to the room log and to supervision.

Pass a short message as one argument. For a long or multi-line message, pipe
it to \`-\` (stdin) so no draft file is needed:
    spl send p1 - <<'EOF'                         (bash, zsh, Git Bash)
    ...message...
    EOF
    @'
    ...message...
    '@ | spl handback c1 -                         (PowerShell)
\`--file <path>\` also works; keep such drafts in a temporary directory,
never inside the repository.
Run \`spl status\` to see open cases and \`spl log <case>\` for a case's history.
If a command reports that a message was recorded but not delivered, fix the cause
(e.g. the target is blocked on a dialog) and run \`spl redeliver <seq>\`. If its
delivery is unconfirmed, it may already have arrived: do not resend it blindly.`;
const GUIDES = {
    lead: `# SPL guide: Lead

You coordinate. You delegate bounded work to Peers and own every decision that
comes back. The human gives you the task in this terminal.

## Delegate
    spl send <peer> - <<'EOF'   (brief text on the following lines, then EOF)

A brief opens a case (c1, c2, ...). It must state what applies of:
- the observable outcome and how it will be accepted (required evidence);
- write scope (paths the Peer may change) or that the work is read-only;
- dependencies, invariants, and constraints the Peer must respect;
- when to come back early: blockers, decisions only you can make.
If the repository keeps plans (e.g. docs/plans/active/), link the plan.

## Handle every handback
A handback arrives in this terminal as "[SPL handback cN ...]". Respond with
    spl reply <case> <peer> "<message>"            (asks for more: a handback is owed)
    spl reply <case> <peer> "<message>" --close    (accept and close: nothing owed)
Each handback needs a disposition: accept (with --close) or reject with a
reason, request specific missing evidence, resolve the decision/dependency, or
defer with an owner and a checkpoint. "OK", "DONE", running tests, or silence
do not close a case; only --close does. A reply without --close may go to
any Peer in the room (e.g. a reviewer); that Peer then owes you a handback.

${COMMON}`,
    peer: `# SPL guide: Peer

You do one bounded piece of work per brief and report back to the Lead.
Briefs arrive as "[SPL brief cN from <lead> ...]"; the Lead may also address
you on an existing case with "[SPL reply cN ...]" (e.g. asking for a review).
Either way you owe a handback on that case. Stay inside the brief's
scope; if the scope is wrong or you are blocked, report instead of expanding it.

## Report
    spl handback <case> - <<'EOF'   (report on the following lines, then EOF)

Every handback states:
- outcome: what was done, against what the brief asked;
- changes: paths changed (or "none, read-only");
- evidence: commands run and their results, or findings for a review;
- status of each ask: complete / missing / failed / unverified — never claim
  unverified work as complete;
- ownership: what you still hold and what you release.
A blocker states the evidence, its consequence, and the decision or
dependency you need from the Lead.

Talk only to the Lead, only through \`spl handback\`. A "[SPL reply cN ..., case
closed]" needs no answer; hand back on a closed case only to report a real
problem, since that reopens it.

${COMMON}`,
    supervisor: `# SPL guide: Supervisor

You review communication in this room; you do not do the work and you do not
accept or reject artifacts. Inspect cases with \`spl status\` and
\`spl log <case>\`. Look for briefs without scope or acceptance evidence,
handbacks that claim unverified work as complete, and handbacks the Lead never
dispositioned. Report concerns to the human in this terminal; do not message
the Lead or Peers unless the human asks you to.

${COMMON}`,
};
// PowerShell's default execution policy blocks npm's spl.ps1 shim; spl.cmd
// works in every Windows shell.
const WINDOWS = "On Windows, if PowerShell refuses `spl` (spl.ps1), run `spl.cmd` instead.";
export function guide(role, platform = process.platform) {
    return platform === "win32" ? `${GUIDES[role]}\n${WINDOWS}` : GUIDES[role];
}
export function onboarding(room, name, role, roster, platform = process.platform, kind = "") {
    const wait = role === "lead" ? "Then wait for the human's task." : role === "peer" ? "Then wait for a brief." : "Then wait for the human.";
    return `You are "${name}", the ${role} of SPL room "${room}". Members: ${roster}. ` +
        `Run \`spl guide\` now and follow it for all coordination in this room. ${wait}` +
        // Claude Code uses Git Bash on Windows, where `spl` works as is.
        (platform === "win32" && kind !== "claude" ? ` ${WINDOWS}` : "");
}
export function envelope(kind, caseId, from, body, closes = false) {
    if (closes) {
        // No mention of handback: an acknowledging handback would reopen the case.
        return `[SPL reply ${caseId} from ${from}, case closed]\n\n${body}\n\n[SPL] No handback is needed; the case is closed. Do not acknowledge it.`;
    }
    const next = kind === "handback"
        ? `Respond with: spl reply ${caseId} <peer> "<message>"  (see \`spl guide\`)`
        : `When finished or blocked, report with: spl handback ${caseId} --file <report.md>  (see \`spl guide\`)`;
    return `[SPL ${kind} ${caseId} from ${from}]\n\n${body}\n\n[SPL] ${next}`;
}
