import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./core/ledger.js";

// The repository's skills (mustang's, or any in .claude/skills and
// .agents/skills) in an slp team: which role reaches for which, and which no
// seat uses because slp does that job. Each seat's guide lists the ones the
// repository has; Claude seats are denied the avoided ones outright.

export interface SkillUse { skill: string; when: string }

export const SKILLS_BY_ROLE: Record<Role, SkillUse[]> = {
  supervisor: [
    { skill: "grilling", when: "settling a request with the Human; their answers go into the concept with `slp context`" },
    { skill: "grill-with-docs", when: "the same, when terms or decisions need recording: the concept takes the Human's word; a repository ADR or glossary is a lane's work" },
    { skill: "domain-modeling", when: "sharpening the project's terms; write them into the concept (`slp context`), never a CONTEXT.md in the repository yourself" },
    { skill: "to-questionnaire", when: "a decision the Human must make that needs several answers from them" },
    { skill: "wait-what", when: "the Human says your last message did not land" },
  ],
  lead: [
    { skill: "codebase-design", when: "deciding seams and interfaces before briefing; name the result in briefs, not the code" },
    { skill: "prototype", when: "a design question is cheaper to answer with a throwaway: brief a Peer to build it" },
    { skill: "research", when: "a question needs primary sources: brief a Peer to research it and write the findings file" },
    { skill: "to-questionnaire", when: "several questions for the Supervisor at once" },
  ],
  peer: [
    { skill: "tdd", when: "building behaviour or fixing a bug: test first" },
    { skill: "diagnosing-bugs", when: "something is broken, throwing, failing or slow" },
    { skill: "codebase-design", when: "your task shapes a module's interface" },
    { skill: "encode-invariant", when: "the brief asks for a rule to be enforced mechanically" },
    { skill: "resolving-merge-conflicts", when: "your brief asks you to reconcile the base with the lane (slp names it when a landing conflicts)" },
    { skill: "research", when: "the brief asks for findings written to a file" },
    { skill: "prototype", when: "the brief asks for a throwaway prototype" },
    { skill: "writing-for-agents", when: "the task edits skills, AGENTS.md or CLAUDE.md" },
  ],
  reviewer: [
    { skill: "code-review", when: "every review: the change against the repository's standards and against the brief (`slp diff` shows the change)" },
  ],
  critic: [],
};

/** Skills no seat uses: slp does their job, or they belong to the Human. */
export const AVOIDED: SkillUse[] = [
  { skill: "herdr", when: "seats reach each other only through slp" },
  { skill: "handoff", when: "the ledger and letters are the hand-off" },
  { skill: "implement", when: "work is briefed task by task; a Peer follows its brief" },
  { skill: "smart-commits", when: "a Peer commits its own task; slp lands lanes and never pushes" },
  { skill: "improve-harness", when: "the Human's call" },
  { skill: "onboard-repository", when: "the Human's call" },
  { skill: "audit-onboarding-proposal", when: "the Human's call" },
  { skill: "find-skills", when: "installing skills is the Human's call" },
  { skill: "wizard", when: "steps only the Human can do go to the Human through the Supervisor" },
  { skill: "teach", when: "a seat works; it does not teach" },
];

/** Names of the skills a repository has (Claude Code's and the agent-neutral trees). */
export async function repoSkills(root: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of [join(root, ".claude", "skills"), join(root, ".agents", "skills")]) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) names.add(e.name);
  }
  return names;
}

/** The guide's section on skills for a role, limited to what the repository has; "" when it has none. */
export function skillsSection(role: Role, present: ReadonlySet<string>): string {
  const use = SKILLS_BY_ROLE[role].filter((s) => present.has(s.skill));
  const avoid = AVOIDED.filter((s) => present.has(s.skill));
  if (!use.length && !avoid.length) return "";
  return [
    "## The repository's skills",
    "",
    ...(use.length ? ["Reach for these when the work calls for them:", ...use.map((s) => `- \`${s.skill}\`: ${s.when}.`)] : []),
    ...(avoid.length ? ["", "Never use these in the team:", ...avoid.map((s) => `- \`${s.skill}\`: ${s.when}.`)] : []),
    "",
    "A skill's own steps give way to this guide where they differ (e.g. a skill that",
    "commits, pushes, or writes files your role does not write).",
  ].join("\n");
}

/** Claude Code deny rules for the avoided skills. */
export function skillDeny(): string[] {
  return AVOIDED.map((s) => `Skill(${s.skill})`);
}
