import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSettings } from "../src/permissions.js";
import { AVOIDED, repoSkills, skillsSection, SKILLS_BY_ROLE } from "../src/skills.js";
import { uncommittedSkills } from "../src/team.js";
import { commitFile, sh, World } from "./helpers.js";

async function addSkill(root: string, tree: ".claude" | ".agents", name: string): Promise<void> {
  await mkdir(join(root, tree, "skills", name), { recursive: true });
  await writeFile(join(root, tree, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

describe("the repository's skills in a team", () => {
  it("lists a role's skills that the repository has, and the ones no seat uses", async () => {
    const w = await World.create();
    for (const s of ["tdd", "code-review", "herdr", "grilling"]) await addSkill(w.repo, ".claude", s);
    await addSkill(w.repo, ".agents", "diagnosing-bugs");
    const present = await repoSkills(w.repo);
    expect([...present].sort()).toEqual(["code-review", "diagnosing-bugs", "grilling", "herdr", "tdd"]);
    const peer = skillsSection("peer", present);
    expect(peer).toMatch(/`tdd`[\s\S]*`diagnosing-bugs`/);
    expect(peer).not.toContain("`code-review`");
    expect(peer).toMatch(/Never use these in the team:[\s\S]*`herdr`/);
    expect(skillsSection("reviewer", present)).toContain("`code-review`");
    expect(skillsSection("supervisor", present)).toContain("`grilling`");
    expect(skillsSection("peer", new Set())).toBe("");
  });

  it("maps only known mustang skills, and never lists an avoided one for use", () => {
    const avoided = new Set(AVOIDED.map((a) => a.skill));
    for (const uses of Object.values(SKILLS_BY_ROLE)) for (const u of uses) expect(avoided.has(u.skill)).toBe(false);
  });

  it("denies Claude seats the avoided skills outright", () => {
    expect(claudeSettings("lead", false, "/h").permissions.deny).toEqual(expect.arrayContaining(["Skill(herdr)", "Skill(handoff)", "Skill(implement)"]));
  });

  it("seats see their skills in slp guide; a Lead names one in a brief", async () => {
    const w = await World.create();
    for (const s of ["tdd", "codebase-design", "herdr"]) await addSkill(w.repo, ".claude", s);
    await commitFile(w.repo, ".claude/skills/tdd/extra.md", "x\n", "add skills");
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"]);
    w.cli.idleAll();
    await w.as("L1", ["guide"]);
    expect(w.out.at(-1)).toMatch(/The repository's skills[\s\S]*`codebase-design`[\s\S]*`herdr`/);
    await expect(w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**", "--skill", "nope"])).rejects.toThrow(/no skill nope/);
    await expect(w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**", "--skill", "herdr"])).rejects.toThrow(/not used in the team/);
    expect(await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**", "--skill", "tdd"])).toBe(0);
    expect((await w.inbox("L1-T1"))[0]).toContain("Use the repository's skill: `tdd`.");
    await w.as("L1-T1", ["guide"]);
    expect(w.out.at(-1)).toMatch(/Reach for these[\s\S]*`tdd`/);
  });

  it("slp start notes skills that lanes in worktrees would not see", async () => {
    const w = await World.create();
    await addSkill(w.repo, ".agents", "tdd");
    expect(await uncommittedSkills(w.repo)).toEqual([".agents/skills/tdd/SKILL.md"]);
    await w.slp(["start"]);
    expect(w.out.some((l) => l.includes("not committed") && l.includes(".agents/skills/tdd/SKILL.md"))).toBe(true);
    sh(w.repo, "add", "-A");
    sh(w.repo, "commit", "-q", "-m", "skills");
    expect(await uncommittedSkills(w.repo)).toEqual([]);
    void readFile;
  });
});
