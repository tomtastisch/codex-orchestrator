import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseExecutionConfig, parsePositiveInteger, type OrchestratorFileConfig } from "./config-schema.js";
import type { Effort } from "./types.js";

/**
 * Serverkonfiguration. Fail-closed: alles Sicherheitsrelevante ist hier
 * zentralisiert und NICHT über Tool-Parameter erreichbar (Plan §11).
 */

export type ModelClass = "fast" | "balanced" | "strong";

export interface ModelEntry {
  class: ModelClass;
  model: string;
  effort: Effort;
  context: string;
  cost: string;
  recommendedFor: string;
}

/** Konkret verfügbares Modell (für models_list; von Claude explizit wählbar). */
export interface AvailableModel {
  model: string;
  /** Zulässige Effort-Stufen für dieses Modell. */
  efforts: Effort[];
  context: string;
  cost: string;
  suggestedClass: ModelClass;
  note: string;
}

export interface CheckSpec {
  /** Logischer Name, der von repo_check referenziert wird. */
  name: string;
  /** argv-Array. KEINE Shell-Interpolation, kein String-Splitting. */
  argv: string[];
  description: string;
}

export interface OrchestratorConfig {
  /** Wurzel für Store + Worktrees. */
  home: string;
  dbPath: string;
  worktreeRoot: string;
  codexBin: string;
  /** Sandbox-Modi, die überhaupt erlaubt sind. danger-full-access fehlt bewusst. */
  allowedSandboxes: ReadonlyArray<"read-only" | "workspace-write">;
  /** Netzwerk für Codex-Slices standardmäßig aus. */
  networkDefault: boolean;
  /** Long-Poll-Timeout-Obergrenze in Sekunden (unter Client-Tool-Timeout). */
  maxWaitSeconds: number;
  /** Grenze, ab der wait_for:"completed" abgelehnt wird (Sekunden Slice-Budget). */
  syncMaxMinutes: number;
  limits: {
    maxSlicesPerTask: number;
    maxTaskMinutes: number;
    maxDiffLines: number;
    maxDiffFiles: number;
    sliceKillGraceMs: number;
  };
  parallelism: {
    maxConcurrent: number;
  };
  /** Klassen-Defaults für model:"auto". */
  models: ModelEntry[];
  /** Konkret verfügbare Modelle (Claude wählt Namen + Effort explizit pro Task). */
  availableModels: AvailableModel[];
  /** Merge-Commits signieren (an = deine gpg/ssh-Signaturpolitik bleibt erhalten). */
  signMergeCommits: boolean;
  /** Allowlist für repo_check. Frei konfigurierbar, aber vom Server fixiert. */
  checks: Record<string, CheckSpec>;
  /** Validated local/remote execution and fallback policy. */
  execution: OrchestratorFileConfig["execution"];
}

// Store-Isolation pro Projekt:
//  1. ORCH_HOME explizit gesetzt  -> genau dieser Store (empfohlen bei
//     projektbezogener MCP-Registrierung: je Projekt ein eigener Pfad).
//  2. sonst <cwd>/.orchestrator    -> jedes Projekt (Arbeitsverzeichnis, in dem
//     der Server startet) bekommt automatisch seinen eigenen Store.
// Damit teilen sich verschiedene Projekte NIE dieselbe DB/Worktrees, und
// gleichzeitig laufende Projekte können sich nicht gegenseitig überschreiben.
const HOME = process.env.ORCH_HOME
  ? resolve(process.env.ORCH_HOME)
  : process.env.ORCH_GLOBAL === "true"
    ? resolve(homedir(), ".codex-orchestrator")
    : resolve(process.cwd(), ".orchestrator");

function loadFileConfig(): OrchestratorFileConfig {
  const path = resolve(process.env.ORCH_CONFIG_FILE || resolve(HOME, "config.json"));
  if (!existsSync(path)) return parseExecutionConfig({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Orchestrator-Konfiguration '${path}' ist kein gültiges JSON: ${message}`);
  }
  return parseExecutionConfig(parsed);
}

const FILE_CONFIG = loadFileConfig();

export const config: OrchestratorConfig = {
  home: HOME,
  dbPath: resolve(HOME, "state.sqlite"),
  worktreeRoot: resolve(HOME, "worktrees"),
  codexBin: process.env.ORCH_CODEX_BIN || "codex",
  allowedSandboxes: ["read-only", "workspace-write"],
  networkDefault: false,
  maxWaitSeconds: 55,
  syncMaxMinutes: 8,
  limits: {
    maxSlicesPerTask: 24,
    maxTaskMinutes: 180,
    maxDiffLines: 4000,
    maxDiffFiles: 60,
    sliceKillGraceMs: 8000,
  },
  parallelism: {
    maxConcurrent: parsePositiveInteger(process.env.ORCH_MAX_CONCURRENT || "2", "ORCH_MAX_CONCURRENT"),
  },
  signMergeCommits: process.env.ORCH_SIGN_MERGE !== "false",
  // Modellnamen leben in der Config, nicht in der Logik (Plan §9). Effort ist
  // der primäre Hebel; Klassen sind nur Defaults für model:"auto".
  models: [
    {
      class: "fast",
      model: process.env.ORCH_MODEL_FAST || "gpt-5.4-mini",
      effort: "low",
      context: "groß",
      cost: "niedrig",
      recommendedFor: "Analyse, Recherche, Doku",
    },
    {
      class: "balanced",
      model: process.env.ORCH_MODEL_BALANCED || "gpt-5.5",
      effort: "medium",
      context: "groß",
      cost: "mittel",
      recommendedFor: "Implementierung, Tests",
    },
    {
      class: "strong",
      model: process.env.ORCH_MODEL_STRONG || "gpt-5.5",
      effort: "high",
      context: "groß",
      cost: "hoch",
      recommendedFor: "Architekturprüfung, komplexe CI-Fixes, Review, Sparring",
    },
  ],
  // Real verfügbare Modelle dieses Accounts (aus Codex-State ermittelt).
  // Über models_list an Claude ausgeliefert; per Task explizit wählbar.
  availableModels: [
    {
      model: "gpt-5.5",
      efforts: ["low", "medium", "high", "xhigh"],
      context: "groß",
      cost: "hoch",
      suggestedClass: "strong",
      note: "Aktuelles Spitzenmodell. Für Architektur, Review, komplexe CI-Fixes, Sparring. xhigh = maximale Tiefe.",
    },
    {
      model: "gpt-5.4",
      efforts: ["low", "medium", "high", "xhigh"],
      context: "groß",
      cost: "mittel",
      suggestedClass: "balanced",
      note: "Solide für Implementierung und Tests.",
    },
    {
      model: "gpt-5.4-mini",
      efforts: ["low", "medium", "high"],
      context: "groß",
      cost: "niedrig",
      suggestedClass: "fast",
      note: "Schnell/günstig für Analyse, Recherche, Doku und einfache Änderungen.",
    },
  ],
  // Nur allowlisted Kommandos. argv-Arrays, keine Shell-Strings.
  checks: {
    git_diff_summary: {
      name: "git_diff_summary",
      argv: ["git", "--no-pager", "diff", "--stat"],
      description: "Zusammenfassung der Änderungen (numstat/stat)",
    },
    git_status: {
      name: "git_status",
      argv: ["git", "status", "--porcelain=v1"],
      description: "Arbeitsbaum-Status",
    },
    mvn_test: {
      name: "mvn_test",
      argv: ["mvn", "-q", "-B", "test"],
      description: "Maven-Testlauf",
    },
    npm_test: {
      name: "npm_test",
      argv: ["npm", "test", "--silent"],
      description: "npm-Testlauf",
    },
    npm_build: {
      name: "npm_build",
      argv: ["npm", "run", "build", "--silent"],
      description: "npm-Build",
    },
    lint: {
      name: "lint",
      argv: ["npm", "run", "lint", "--silent"],
      description: "Lint",
    },
    typecheck: {
      name: "typecheck",
      argv: ["npm", "run", "typecheck", "--silent"],
      description: "TypeScript typecheck",
    },
  },
  execution: FILE_CONFIG.execution,
};

export function modelForClass(cls: ModelClass): ModelEntry {
  const m = config.models.find((e) => e.class === cls);
  if (!m) throw new Error(`Unbekannte Modellklasse: ${cls}`);
  return m;
}
