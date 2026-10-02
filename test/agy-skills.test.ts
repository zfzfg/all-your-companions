import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agySkillInstructions, discoverAgySkills } from "../src/agy-skills";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-")); dirs.push(dir); return dir; }
function skill(root: string, directory: string, name: string, extra = "", description = "Apply this skill") {
  const dir = path.join(root, directory); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\nSkill body\n`);
  return file;
}

describe("Antigravity skill commands", () => {
  it("prefers workspace skills and native names and hides non-invocable or malformed skills", () => {
    const cwd = root(); const home = root();
    const project = skill(cwd, ".agents/skills/review", "review");
    skill(home, ".codex/skills/review", "review");
    skill(cwd, ".gemini/skills/private", "private", "user-invocable: false\n");
    skill(cwd, ".codex/skills/no-description", "missing", "", "");
    skill(cwd, ".agents/skills/native", "compact");
    skill(cwd, ".agents/skills/host", "crew");
    skill(home, ".gemini/config/skills/global", "global");
    const commands = discoverAgySkills(cwd, home);
    expect(commands.map(command => command.name)).toEqual(["review", "global"]);
    expect(commands[0]._meta).toEqual({ scope: "project", path: project });
    expect(commands[1]._meta.scope).toBe("user");
  });

  it("isolates concurrent workspaces and only selects explicit slash references", () => {
    const first = root(); const second = root(); const home = root();
    skill(first, ".agents/skills/first", "first"); skill(second, ".agents/skills/second", "second");
    const a = discoverAgySkills(first, home); const b = discoverAgySkills(second, home);
    expect(a.map(command => command.name)).toEqual(["first"]);
    expect(b.map(command => command.name)).toEqual(["second"]);
    expect(agySkillInstructions("please /first now", a)).toContain(a[0]._meta.path.replace(/\\/g, "\\\\"));
    expect(agySkillInstructions("/first-other /second path/first", a)).toBe("");
  });

  it("continues after read and directory failures and accepts multiline descriptions", () => {
    const cwd = root(); const home = root();
    const bad = skill(cwd, ".agents/skills/broken", "broken");
    skill(cwd, ".codex/skills/good", "good", "", ">\n  Line one\n  line two");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === bad) throw new Error("permission denied");
      return (read as any)(file, ...args);
    }) as any);
    expect(discoverAgySkills(cwd, home)).toMatchObject([{ name: "good", description: "Line one line two" }]);
  });
});
