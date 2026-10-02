import fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./agent-roles";
import { HOST_SLASH_COMMANDS } from "./slash-filter";

export interface AgySkillCommand {
  name: string;
  description: string;
  _meta: { path: string; scope: "project" | "user" };
}

export function discoverAgySkills(cwd: string, home: string, nativeNames: readonly string[] = ["compact"]): AgySkillCommand[] {
  const found = new Map<string, AgySkillCommand>();
  const reserved = new Set([...HOST_SLASH_COMMANDS, ...nativeNames]);
  const roots: Array<[string, "project" | "user"]> = [
    ...[".agents/skills", ".gemini/skills", ".codex/skills"].map(dir => [path.join(cwd, dir), "project"] as [string, "project"]),
    ...[".gemini/skills", ".gemini/config/skills", ".agents/skills", ".codex/skills"].map(dir => [path.join(home, dir), "user"] as [string, "user"]),
  ];
  for (const [root, scope] of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, "SKILL.md");
        try {
          if (fs.statSync(file).size > 128 * 1024) continue;
          const { fields, error } = parseFrontmatter(fs.readFileSync(file, "utf8"));
          const name = fields.name;
          const description = fields.description;
          if (error || typeof name !== "string" || !/^[a-zA-Z0-9][\w.-]*$/.test(name)
            || typeof description !== "string" || !description.trim()
            || fields["user-invocable"] === false || fields.user_invocable === false
            || reserved.has(name) || found.has(name)) continue;
          found.set(name, { name, description: description.trim(), _meta: { path: file, scope } });
        } catch { /* A broken skill does not hide the other commands. */ }
      }
    } catch { /* Missing or unreadable roots are optional. */ }
  }
  return [...found.values()];
}

export function agySkillInstructions(text: string, commands: readonly AgySkillCommand[]): string {
  const selected = commands.filter(command => {
    const escaped = command.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)/${escaped}(?=\\s|$)`).test(text);
  }).slice(0, 8);
  return selected.map(command => `For /${command.name}, read and apply the skill at ${JSON.stringify(command._meta.path)}.`).join("\n");
}
