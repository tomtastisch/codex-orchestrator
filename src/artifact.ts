/**
 * Finales Gesamtartefakt (Cluster 6).
 *
 * Am Ende eines vollständigen Orchestrator-Laufs wird ein versioniertes,
 * maschinenlesbares Ergebnisartefakt erzeugt: TOML mit Endung `.toln`, plus
 * optional eine `summary.md`. Das Artefakt bündelt Plan, Cluster, Tasks,
 * Agentenjobs, Hypothesen (inkl. aller Aktualisierungen), Reviews,
 * Nutzerentscheidungen, geänderte Dateien, Tests, Findings und eine
 * Gesamtbewertung — mit Prüfsumme über den logischen Inhalt.
 *
 * Der TOML-Emitter ist bewusst dependency-frei und auf ein kontrolliertes
 * Schema beschränkt (Top-Level-Skalare, String-Arrays, Arrays-of-Tables mit
 * skalaren/String-Array-Feldern; komplexe Werte als eingebettetes JSON).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import { SCHEMA_VERSION, type PersistenceStore } from "./ports/persistence.js";
import { HypothesisRepo } from "./hypotheses.js";
import { redactDeep } from "./redact.js";

export const ARTIFACT_SCHEMA_VERSION = SCHEMA_VERSION;

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface ArtifactOptions {
  originalUserRequest?: string;
  interpretedGoal?: string;
  finalAssessment?: string;
  recommendedNextSteps?: string[];
  gitCommitBefore?: string | null;
}

export interface ResultArtifact {
  schemaVersion: number;
  artifactVersion: number;
  timestamp: string;
  projectName: string;
  gitBranch: string | null;
  gitCommitBefore: string | null;
  gitCommitAfter: string | null;
  originalUserRequest: string;
  interpretedGoal: string;
  clusters: any[];
  tasks: any[];
  agentJobs: any[];
  hypotheses: any[];
  hypothesisUpdates: any[];
  reviews: any[];
  userDecisions: any[];
  filesChanged: string[];
  testsRun: any[];
  findings: any[];
  unresolvedIssues: string[];
  finalAssessment: string;
  recommendedNextSteps: string[];
  checksum: string;
}

function parseJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/** Baut das vollständige Artefakt-Objekt (inkl. deterministischer Prüfsumme). */
export function buildResultArtifact(
  store: PersistenceStore,
  hyp: HypothesisRepo,
  planId: string,
  opts: ArtifactOptions = {},
): ResultArtifact | null {
  const plan = store.getPlan(planId);
  if (!plan) return null;
  const repo = plan.repo_path;

  const clusters = store.listClusters(planId).map((c) => ({
    id: c.id, ordinal: c.ordinal, name: c.name, status: c.status, goal: c.goal,
    acceptance: parseJson(c.acceptance_json), review_strategy: parseJson(c.review_strategy_json),
    latest_review: (() => { const r = store.latestReview(c.id); return r ? { status: r.status, ts: r.ts } : null; })(),
    checks: store.checksForCluster(c.id).map((k) => ({ cmd: k.cmd, exit_code: k.exit_code })),
  }));

  // Alles strikt auf DIESEN Plan begrenzen (ein Store kann mehrere Pläne halten) —
  // ein Audit-Artefakt darf keine Daten fremder Pläne einmischen.
  const clusterIds = new Set(clusters.map((c) => c.id));
  const planTasks = store.listTasks().filter((t) => t.cluster_id !== null && clusterIds.has(t.cluster_id));
  const taskIds = new Set(planTasks.map((t) => t.id));
  const tasks = planTasks.map((t) => ({
    id: t.id, cluster_id: t.cluster_id, status: t.status, sandbox: t.sandbox,
    model: t.model, effort: t.effort, hypothesis_id: t.hypothesis_id,
    slice_count: t.slice_count, last_slice_type: t.last_slice_type,
  }));

  const agentJobs = store.listAgentJobs()
    .filter((j: any) => (j.cluster_id && clusterIds.has(j.cluster_id)) || (j.task_id && taskIds.has(j.task_id)))
    .map((j: any) => ({
      id: j.id, task_id: j.task_id, cluster_id: j.cluster_id, hypothesis_id: j.hypothesis_id,
      model: j.model, effort: j.effort, sandbox: j.sandbox, status: j.status,
      started_at: j.started_at, ended_at: j.ended_at,
    }));

  // Rich-Hypothesen dieses Plans: plan_id ODER an einen Cluster/Task des Plans gebunden.
  // Neueste Version = "Hypothese", volle Versionshistorie = "hypothesisUpdates".
  const richIds = new Set<string>();
  const allHeaders = store.listHypothesisHeaders();
  const headers = allHeaders.filter((h) =>
    h.plan_id === planId ||
    (h.cluster_id && clusterIds.has(h.cluster_id)) ||
    (h.task_id && taskIds.has(h.task_id)),
  );
  const hypotheses: any[] = [];
  const hypothesisUpdates: any[] = [];
  for (const { id } of headers) {
    const versions = hyp.listVersions(id);
    if (!versions.length) continue; // Legacy-Freitext-Hypothesen ohne Snapshot überspringen.
    richIds.add(id);
    hypotheses.push(HypothesisRepo.serialize(versions[versions.length - 1]));
    for (const v of versions) hypothesisUpdates.push(HypothesisRepo.serialize(v));
  }

  const reviews = [
    ...clusters.flatMap((c) => {
      const r = store.latestReview(c.id);
      return r ? [{ kind: "cluster", cluster_id: c.id, status: r.status, findings: parseJson(r.findings_json), ts: r.ts }] : [];
    }),
    ...store.listHypothesisReviews()
      .filter((r: any) => (r.cluster_id && clusterIds.has(r.cluster_id)) || (r.hypothesis_id && richIds.has(r.hypothesis_id)))
      .map((r: any) => ({
        kind: "hypothesis", hypothesis_id: r.hypothesis_id, cluster_id: r.cluster_id,
        reviewer: r.reviewer, status: r.status, findings: parseJson(r.findings_json), synthesis: r.synthesis,
      })),
  ];

  const userDecisions = store.listDecisions()
    .filter((d: any) => d.plan_id === planId || (d.cluster_id && clusterIds.has(d.cluster_id)))
    .map((d: any) => ({
      id: d.id, cluster_id: d.cluster_id, topic: d.topic, decision: d.decision,
      remember: !!d.remember, question: d.question, created_at: d.created_at,
    }));

  // Geänderte Dateien: aus git (Basis..HEAD, sonst working tree), best effort.
  let filesChanged: string[] = [];
  const before = opts.gitCommitBefore ?? null;
  const nameOnly = before
    ? git(repo, ["--no-pager", "diff", "--name-only", `${before}..HEAD`])
    : git(repo, ["--no-pager", "diff", "--name-only", "HEAD~1..HEAD"]);
  if (nameOnly) filesChanged = nameOnly.split("\n").filter(Boolean);

  const testsRun = clusters.flatMap((c) =>
    store.checksForCluster(c.id).map((k) => ({ cluster_id: c.id, cmd: k.cmd, exit_code: k.exit_code })),
  );

  const findings = reviews.flatMap((r: any) =>
    Array.isArray(r.findings) ? r.findings.map((f: any) => ({ source: r.kind, cluster_id: r.cluster_id ?? null, finding: typeof f === "string" ? f : JSON.stringify(f) })) : [],
  );

  // Offene Punkte: nicht-confirmte Cluster, offene/widerlegte Hypothesen, Folgefragen.
  const unresolvedIssues: string[] = [];
  for (const c of clusters) if (c.status !== "confirmed") unresolvedIssues.push(`Cluster ${c.id} ist ${c.status}, nicht confirmed`);
  for (const h of hypotheses) {
    if (h.result === "refuted" || h.result === "partially_confirmed") {
      for (const q of h.followUpQuestions ?? []) unresolvedIssues.push(`Folgefrage (${h.id}): ${q}`);
    } else if (h.result === "open") {
      unresolvedIssues.push(`Hypothese ${h.id} noch offen`);
    }
  }

  const recommendedNextSteps = opts.recommendedNextSteps ?? (() => {
    const steps = hypotheses.flatMap((h) => (h.nextAction ? [h.nextAction] : []));
    return steps.length ? steps : ["Alle Cluster confirmed — keine offenen Folgeschritte."];
  })();

  // Cluster 7: Secrets/Token aus allen String-Werten scrubben, BEVOR die Prüfsumme
  // gebildet wird — das Artefakt enthält damit garantiert keine Geheimnisse.
  const artifact: Omit<ResultArtifact, "checksum"> = redactDeep({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactVersion: store.latestArtifactVersion(planId, "toln") + 1,
    timestamp: new Date().toISOString(),
    projectName: basename(repo),
    gitBranch: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitCommitBefore: before,
    gitCommitAfter: git(repo, ["rev-parse", "HEAD"]),
    originalUserRequest: opts.originalUserRequest ?? plan.goal,
    interpretedGoal: opts.interpretedGoal ?? plan.goal,
    clusters, tasks, agentJobs, hypotheses, hypothesisUpdates, reviews, userDecisions,
    filesChanged, testsRun, findings, unresolvedIssues,
    finalAssessment: opts.finalAssessment ??
      (unresolvedIssues.length === 0
        ? "Alle Cluster confirmed, keine offenen Punkte."
        : `${unresolvedIssues.length} offene(r) Punkt(e) verbleiben.`),
    recommendedNextSteps,
  });

  const checksum = computeChecksum(artifact);
  return { ...artifact, checksum };
}

/** Deterministische SHA-256-Prüfsumme über den logischen Inhalt (ohne checksum). */
export function computeChecksum(artifact: object): string {
  return "sha256:" + createHash("sha256").update(stableStringify(artifact)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as any)[k])).join(",") + "}";
}

// ------------------------------------------------------------------ TOML-Emitter
function tomlStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}
function tomlValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : '""';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return "[" + v.map((x) => tomlStr(x as string)).join(", ") + "]";
    return tomlStr(JSON.stringify(v)); // komplexe Arrays als eingebettetes JSON
  }
  if (typeof v === "object") return tomlStr(JSON.stringify(v)); // verschachtelte Objekte als JSON
  return tomlStr(String(v));
}
function emitTable(item: Record<string, unknown>): string {
  return Object.entries(item).map(([k, val]) => `${k} = ${tomlValue(val)}`).join("\n") + "\n";
}

/** Rendert das Artefakt als TOML (.toln-Inhalt). */
export function renderToln(a: ResultArtifact): string {
  const scalars: (keyof ResultArtifact)[] = [
    "schemaVersion", "artifactVersion", "timestamp", "projectName", "gitBranch",
    "gitCommitBefore", "gitCommitAfter", "originalUserRequest", "interpretedGoal",
    "finalAssessment", "checksum",
  ];
  const stringArrays: (keyof ResultArtifact)[] = ["filesChanged", "unresolvedIssues", "recommendedNextSteps"];
  const tableArrays: (keyof ResultArtifact)[] = [
    "clusters", "tasks", "agentJobs", "hypotheses", "hypothesisUpdates", "reviews", "userDecisions", "testsRun", "findings",
  ];

  let out = "# codex-orchestration-result — versioned run artifact (.toln / TOML)\n\n";
  for (const k of scalars) out += `${k} = ${tomlValue(a[k])}\n`;
  out += "\n";
  for (const k of stringArrays) out += `${k} = ${tomlValue(a[k])}\n`;
  out += "\n";
  for (const k of tableArrays) {
    const items = a[k] as any[];
    for (const item of items) out += `[[${k}]]\n${emitTable(item)}\n`;
  }
  return out;
}

/** Rendert eine knappe menschenlesbare Zusammenfassung (summary.md). */
export function renderSummaryMd(a: ResultArtifact): string {
  const confirmed = a.clusters.filter((c) => c.status === "confirmed").length;
  const lines = [
    `# Orchestration Summary — ${a.projectName}`,
    "",
    `- **Timestamp:** ${a.timestamp}`,
    `- **Artifact:** v${a.artifactVersion} (schema v${a.schemaVersion})`,
    `- **Branch:** ${a.gitBranch ?? "?"} @ ${a.gitCommitAfter?.slice(0, 12) ?? "?"}`,
    `- **Goal:** ${a.interpretedGoal}`,
    "",
    `## Clusters (${confirmed}/${a.clusters.length} confirmed)`,
    ...a.clusters.map((c) => `- \`${c.id}\` ${c.name} — **${c.status}**`),
    "",
    `## Hypotheses (${a.hypotheses.length})`,
    ...a.hypotheses.map((h) => `- \`${h.id}\` result: **${h.result}**, v${h.version} — ${h.initialAssumption}`),
    "",
    `## Files changed (${a.filesChanged.length})`,
    ...(a.filesChanged.length ? a.filesChanged.map((f) => `- \`${f}\``) : ["- (none detected)"]),
    "",
    `## Unresolved (${a.unresolvedIssues.length})`,
    ...(a.unresolvedIssues.length ? a.unresolvedIssues.map((u) => `- ${u}`) : ["- none"]),
    "",
    `## Final assessment`,
    a.finalAssessment,
    "",
    `## Recommended next steps`,
    ...a.recommendedNextSteps.map((s) => `- ${s}`),
    "",
    `_checksum: ${a.checksum}_`,
    "",
  ];
  return lines.join("\n");
}

export interface WriteArtifactResult {
  tolnPath: string;
  summaryPath: string;
  artifact: ResultArtifact;
}

/** Erzeugt Dateien, registriert das Artefakt in der DB und gibt die Pfade zurück. */
export function writeResultArtifact(
  store: PersistenceStore,
  hyp: HypothesisRepo,
  planId: string,
  opts: ArtifactOptions = {},
): WriteArtifactResult | null {
  const artifact = buildResultArtifact(store, hyp, planId, opts);
  if (!artifact) return null;
  const dir = join(config.home, "artifacts");
  mkdirSync(dir, { recursive: true });
  const stamp = artifact.timestamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `codex-orchestration-result.v${artifact.schemaVersion}.${stamp}`;
  const tolnPath = join(dir, `${base}.toln`);
  const summaryPath = join(dir, `${base}.summary.md`);
  writeFileSync(tolnPath, renderToln(artifact), "utf8");
  writeFileSync(summaryPath, renderSummaryMd(artifact), "utf8");
  store.addArtifact({
    planId, kind: "toln", path: tolnPath,
    schemaVersion: artifact.schemaVersion, artifactVersion: artifact.artifactVersion, checksum: artifact.checksum,
  });
  return { tolnPath, summaryPath, artifact };
}
