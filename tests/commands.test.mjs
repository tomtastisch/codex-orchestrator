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

test("Haupt-Slash-Command /codex-orchestrator ist vorhanden und wohlgeformt", () => {
  const file = join(commandsDir, "codex-orchestrator.md");
  assert.ok(existsSync(file), "commands/codex-orchestrator.md fehlt");
  const body = readFileSync(file, "utf8");
  // Frontmatter mit description (wird im /-Menü angezeigt).
  assert.match(body, /^---\s*[\s\S]*?description:\s*.+[\s\S]*?---/, "Frontmatter mit description fehlt");
  // Verweist auf das Skill / die Orchestrator-Rolle.
  assert.match(body, /codex-orchestrator/i);
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
