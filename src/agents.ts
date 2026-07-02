import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Template liegt neben dem Projekt (…/templates/AGENTS.executor.md). dist/ liegt eine Ebene tiefer.
function templatePath(): string {
  const candidates = [
    resolve(__dirname, "../templates/AGENTS.executor.md"),
    resolve(__dirname, "../../templates/AGENTS.executor.md"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Zentrale Kopie der Executor-AGENTS.md unter ORCH_HOME sicherstellen. */
export function centralAgentsMd(): string {
  const dest = join(config.home, "AGENTS.md");
  try {
    mkdirSync(config.home, { recursive: true });
    const tpl = templatePath();
    if (existsSync(tpl)) copyFileSync(tpl, dest);
  } catch { /* best effort */ }
  return dest;
}

/**
 * Stellt sicher, dass im Arbeitsverzeichnis (worktree/Repo), in dem Codex läuft,
 * eine AGENTS.md liegt. Vorhandene Projekt-AGENTS.md wird respektiert (nur um die
 * Executor-Rolle ergänzt, falls der Marker fehlt). Fehlt eine ganz, wird die
 * Executor-Vorlage geschrieben. So hat Codex IMMER seine Rolle vorliegen.
 */
export function ensureAgentsMd(workingDir: string): { path: string; action: "created" | "appended" | "present" } {
  const target = join(workingDir, "AGENTS.md");
  const marker = "codex-orchestrator";
  let executorText = "";
  try {
    executorText = readFileSync(templatePath(), "utf8");
  } catch {
    executorText = "# AGENTS.md — Codex Executor Role (codex-orchestrator)\n\nBeende jeden Slice mit einem SLICE_RESULT-Block. Improvisiere nie um fehlende Informationen herum.\n";
  }

  if (!existsSync(target)) {
    try {
      mkdirSync(workingDir, { recursive: true });
      writeFileSync(target, executorText, "utf8");
      return { path: target, action: "created" };
    } catch {
      return { path: target, action: "present" };
    }
  }

  const current = readFileSync(target, "utf8");
  if (current.includes(marker)) return { path: target, action: "present" };
  // Vorhandene Projekt-AGENTS.md respektieren und Executor-Rolle anhängen.
  try {
    writeFileSync(
      target,
      current.trimEnd() + "\n\n---\n\n" + executorText,
      "utf8",
    );
    return { path: target, action: "appended" };
  } catch {
    return { path: target, action: "present" };
  }
}
