import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commandsDir = join(root, "commands");

test("commands-Verzeichnis existiert (Slash-Command-Discovery)", () => {
  assert.ok(existsSync(commandsDir), "commands/ fehlt — Plugin ist nicht per Slash-Command nutzbar");
});

test("Haupt-Slash-Command wird eindeutig über den Plugin-Skill bereitgestellt", () => {
  const file = join(root, "skills", "codex-orchestrator", "SKILL.md");
  assert.ok(existsSync(file), "skills/codex-orchestrator/SKILL.md fehlt");
  assert.equal(existsSync(join(commandsDir, "codex-orchestrator.md")), false,
    "gleichnamiger Legacy-Command würde den Slash-Skill doppelt registrieren");
  const body = readFileSync(file, "utf8");
  // Frontmatter mit description (wird im /-Menü angezeigt).
  assert.match(body, /^---\s*[\s\S]*?description:\s*.+[\s\S]*?---/, "Frontmatter mit description fehlt");
  assert.match(body, /name:\s*codex-orchestrator/);
  assert.match(body, /user-invocable:\s*true/);
  assert.match(body, /\$ARGUMENTS/);
});

test("jede Command-Datei hat Frontmatter mit description", () => {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "keine Command-Dateien gefunden");
  for (const f of files) {
    const body = readFileSync(join(commandsDir, f), "utf8");
    assert.match(body, /^---/, `${f}: kein Frontmatter`);
    assert.match(body, /description:\s*\S/, `${f}: keine description`);
  }
});
