/**
 * Versioniertes Hypothesenmodell (Cluster 1).
 *
 * Kern der selbstkritischen Arbeitsweise: Vor jeder Aufgabe bildet Claude eine
 * Hypothese, hinterfragt sie (criticalQuestions), leitet einen Falsifikations-/
 * Prüfplan ab und aktualisiert sie nach der Ausführung anhand der Evidenz.
 *
 * Versionierung ist append-only: jede Aktualisierung erzeugt eine neue,
 * unveränderliche Version als vollständigen Snapshot. Der Header-Datensatz in
 * `hypotheses` trägt Identität + Zeiger auf die neueste Version; die
 * `hypothesis_versions`-Tabelle hält jede Version als serialisierten Snapshot.
 * Damit ist jede Änderung lückenlos nachvollziehbar.
 */
import { systemClock, systemIdGenerator } from "./system-clock.js";
import type { Clock, IdGenerator } from "./ports/clock.js";
import type { PersistenceStore } from "./ports/persistence.js";
import type { HypothesisStatus } from "./types.js";

/** Ergebnis der Hypothesenprüfung nach Ausführung (Cluster 3). */
export type HypothesisResult =
  | "open"
  | "confirmed"
  | "partially_confirmed"
  | "refuted";

export const HYPOTHESIS_RESULTS: HypothesisResult[] = [
  "open",
  "confirmed",
  "partially_confirmed",
  "refuted",
];

/** Eine kritische Rückfrage an die eigene Annahme (aktives Hinterfragen). */
export interface CriticalQuestion {
  question: string;
  answer?: string | null;
}

/** Ein Schritt des Falsifikationsplans: wie könnte die Annahme scheitern? */
export interface FalsificationStep {
  description: string;
  /** Womit wird geprüft (Check, Testkommando, Beobachtung)? */
  method?: string | null;
  /** Was wäre zu beobachten, wenn die Hypothese FALSCH ist? */
  expectationIfFalse?: string | null;
  /** Tatsächlich beobachtet (nach Ausführung gefüllt). */
  observed?: string | null;
}

/** Ein Evidenzstück, das nach der Ausführung gesammelt wurde. */
export interface EvidenceItem {
  source: string;
  observation: string;
  ts?: string;
}

/**
 * Vollständige Hypothese (eine konkrete Version). Feldnamen entsprechen exakt
 * der geforderten Spezifikation (camelCase) und bilden die Serialisierung.
 */
export interface Hypothesis {
  id: string;
  planId: string | null;
  taskId: string | null;
  clusterId: string | null;
  version: number;
  status: HypothesisStatus;
  initialAssumption: string;
  confidenceBefore: number;
  criticalQuestions: CriticalQuestion[];
  falsificationPlan: FalsificationStep[];
  evidence: EvidenceItem[];
  result: HypothesisResult;
  confidenceAfter: number | null;
  updatedAssumption: string | null;
  /** Cluster 3: Folgefragen aus teilweiser/widerlegter Bestätigung. */
  followUpQuestions: string[];
  /** Cluster 3: erkannte Risiken/Folgeprobleme. */
  risks: string[];
  /** Cluster 3: nächste sinnvolle Aktion. */
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Eingabe zum Anlegen einer Hypothese (vor der Aufgabe). */
export interface CreateHypothesisInput {
  planId?: string | null;
  taskId?: string | null;
  clusterId?: string | null;
  initialAssumption: string;
  confidenceBefore: number;
  criticalQuestions?: (CriticalQuestion | string)[];
  falsificationPlan?: (FalsificationStep | string)[];
}

/** Patch zum Aktualisieren einer Hypothese (nach der Aufgabe). */
export interface UpdateHypothesisInput {
  status?: HypothesisStatus;
  result?: HypothesisResult;
  confidenceAfter?: number | null;
  updatedAssumption?: string | null;
  addEvidence?: (EvidenceItem | string)[];
  criticalQuestions?: (CriticalQuestion | string)[];
  falsificationPlan?: (FalsificationStep | string)[];
  followUpQuestions?: string[];
  risks?: string[];
  nextAction?: string | null;
  taskId?: string | null;
  clusterId?: string | null;
}

/** Ergebnisse, die zwingend Folgefragen erfordern (nicht vollständig bestätigt). */
export function needsFollowUp(result: HypothesisResult): boolean {
  return result === "partially_confirmed" || result === "refuted";
}

function clampConfidence(v: number, field: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`${field} muss eine Zahl in [0,1] sein`);
  }
  if (v < 0 || v > 1) {
    throw new Error(`${field}=${v} liegt außerhalb [0,1]`);
  }
  return v;
}

function normQuestions(qs?: (CriticalQuestion | string)[]): CriticalQuestion[] {
  if (!qs) return [];
  return qs.map((q) =>
    typeof q === "string" ? { question: q, answer: null } : { question: q.question, answer: q.answer ?? null },
  );
}

function normFalsification(fs?: (FalsificationStep | string)[]): FalsificationStep[] {
  if (!fs) return [];
  return fs.map((f) =>
    typeof f === "string"
      ? { description: f, method: null, expectationIfFalse: null, observed: null }
      : {
          description: f.description,
          method: f.method ?? null,
          expectationIfFalse: f.expectationIfFalse ?? null,
          observed: f.observed ?? null,
        },
  );
}

function normEvidence(es: (EvidenceItem | string)[] | undefined, clock: Clock): EvidenceItem[] {
  if (!es) return [];
  return es.map((e) =>
    typeof e === "string"
      ? { source: "note", observation: e, ts: clock.now() }
      : { source: e.source, observation: e.observation, ts: e.ts ?? clock.now() },
  );
}

/**
 * Repository-/DAO-Schicht für versionierte Hypothesen. Kapselt sämtliche
 * SQL-Zugriffe (nur prepared statements, keine String-Verkettung) und die
 * Serialisierung. Statuswechsel/Versionierung laufen in Transaktionen.
 */
export class HypothesisRepo {
  constructor(
    private store: PersistenceStore,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = systemIdGenerator,
  ) {}

  /** Serialisiert eine Hypothese in ein stabiles, maschinenlesbares Objekt. */
  static serialize(h: Hypothesis): Record<string, unknown> {
    return {
      id: h.id,
      planId: h.planId,
      taskId: h.taskId,
      clusterId: h.clusterId,
      version: h.version,
      status: h.status,
      initialAssumption: h.initialAssumption,
      confidenceBefore: h.confidenceBefore,
      criticalQuestions: h.criticalQuestions,
      falsificationPlan: h.falsificationPlan,
      evidence: h.evidence,
      result: h.result,
      confidenceAfter: h.confidenceAfter,
      updatedAssumption: h.updatedAssumption,
      followUpQuestions: h.followUpQuestions,
      risks: h.risks,
      nextAction: h.nextAction,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    };
  }

  /** Rehydriert eine Hypothese aus einem serialisierten Snapshot. */
  static deserialize(o: Record<string, unknown>): Hypothesis {
    return {
      id: String(o.id),
      planId: (o.planId as string) ?? null,
      taskId: (o.taskId as string) ?? null,
      clusterId: (o.clusterId as string) ?? null,
      version: Number(o.version),
      status: (o.status as HypothesisStatus) ?? "open",
      initialAssumption: String(o.initialAssumption ?? ""),
      confidenceBefore: Number(o.confidenceBefore ?? 0),
      criticalQuestions: (o.criticalQuestions as CriticalQuestion[]) ?? [],
      falsificationPlan: (o.falsificationPlan as FalsificationStep[]) ?? [],
      evidence: (o.evidence as EvidenceItem[]) ?? [],
      result: (o.result as HypothesisResult) ?? "open",
      confidenceAfter: (o.confidenceAfter as number | null) ?? null,
      updatedAssumption: (o.updatedAssumption as string | null) ?? null,
      followUpQuestions: (o.followUpQuestions as string[]) ?? [],
      risks: (o.risks as string[]) ?? [],
      nextAction: (o.nextAction as string | null) ?? null,
      createdAt: String(o.createdAt ?? ""),
      updatedAt: String(o.updatedAt ?? ""),
    };
  }

  /** Legt eine neue Hypothese (Version 1) an. */
  create(input: CreateHypothesisInput): Hypothesis {
    if (!input.initialAssumption || !input.initialAssumption.trim()) {
      throw new Error("initialAssumption ist erforderlich");
    }
    const confidenceBefore = clampConfidence(input.confidenceBefore, "confidenceBefore");
    const id = this.ids.newId("H");
    const ts = this.clock.now();
    const h: Hypothesis = {
      id,
      planId: input.planId ?? null,
      taskId: input.taskId ?? null,
      clusterId: input.clusterId ?? null,
      version: 1,
      status: "open",
      initialAssumption: input.initialAssumption,
      confidenceBefore,
      criticalQuestions: normQuestions(input.criticalQuestions),
      falsificationPlan: normFalsification(input.falsificationPlan),
      evidence: [],
      result: "open",
      confidenceAfter: null,
      updatedAssumption: null,
      followUpQuestions: [],
      risks: [],
      nextAction: null,
      createdAt: ts,
      updatedAt: ts,
    };
    return this.store.tx(() => {
      this.store.insertHypothesisHeader({
        id: h.id,
        planId: h.planId ?? "", // Header-Spalte ist NOT NULL (Legacy); Snapshot behält echtes null.
        taskId: h.taskId,
        clusterId: h.clusterId,
        text: h.initialAssumption,
        status: h.status,
        result: h.result,
        latestVersion: h.version,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
      });
      this.writeVersion(h);
      return h;
    });
  }

  private writeVersion(h: Hypothesis): void {
    this.store.insertHypothesisVersion({
      id: this.ids.newId("HV"),
      hypothesisId: h.id,
      version: h.version,
      snapshotJson: JSON.stringify(HypothesisRepo.serialize(h)),
      createdAt: h.updatedAt,
    });
  }

  /**
   * Aktualisiert eine Hypothese: erzeugt append-only eine neue Version aus der
   * neuesten und schreibt den Header fort. Die alten Versionen bleiben
   * unverändert erhalten (Nachvollziehbarkeit).
   */
  update(id: string, patch: UpdateHypothesisInput): Hypothesis {
    return this.store.tx(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Hypothese ${id} nicht gefunden`);
      const ts = this.clock.now();
      const result = patch.result ?? current.result;
      const followUpQuestions =
        patch.followUpQuestions !== undefined ? patch.followUpQuestions : current.followUpQuestions;
      // Cluster 3: teilweise/widerlegte Hypothesen MÜSSEN Folgefragen erzeugen.
      if (needsFollowUp(result) && followUpQuestions.length === 0) {
        throw new Error(
          `Ergebnis '${result}' erfordert mindestens eine Folgefrage (followUpQuestions): ` +
            "Was bleibt offen? Welche neue Hypothese folgt? Welche Risiken/nächste Aktion?",
        );
      }
      const next: Hypothesis = {
        ...current,
        version: current.version + 1,
        status: patch.status ?? current.status,
        result,
        followUpQuestions,
        risks: patch.risks !== undefined ? patch.risks : current.risks,
        nextAction: patch.nextAction !== undefined ? patch.nextAction : current.nextAction,
        confidenceAfter:
          patch.confidenceAfter !== undefined
            ? patch.confidenceAfter === null
              ? null
              : clampConfidence(patch.confidenceAfter, "confidenceAfter")
            : current.confidenceAfter,
        updatedAssumption:
          patch.updatedAssumption !== undefined ? patch.updatedAssumption : current.updatedAssumption,
        criticalQuestions: patch.criticalQuestions
          ? normQuestions(patch.criticalQuestions)
          : current.criticalQuestions,
        falsificationPlan: patch.falsificationPlan
          ? normFalsification(patch.falsificationPlan)
          : current.falsificationPlan,
        evidence: patch.addEvidence
          ? [...current.evidence, ...normEvidence(patch.addEvidence, this.clock)]
          : current.evidence,
        taskId: patch.taskId !== undefined ? patch.taskId : current.taskId,
        clusterId: patch.clusterId !== undefined ? patch.clusterId : current.clusterId,
        updatedAt: ts,
      };
      this.store.updateHypothesisHeader(id, {
        status: next.status,
        result: next.result,
        latestVersion: next.version,
        updatedAt: next.updatedAt,
        taskId: next.taskId,
        clusterId: next.clusterId,
        evidenceJson: next.evidence.length ? JSON.stringify(next.evidence) : null,
      });
      this.writeVersion(next);
      return next;
    });
  }

  /** Lädt die neueste Version einer Hypothese. */
  get(id: string): Hypothesis | undefined {
    const snapshot = this.store.latestHypothesisSnapshot(id);
    if (snapshot === undefined) return undefined;
    return HypothesisRepo.deserialize(JSON.parse(snapshot));
  }

  /** Lädt eine konkrete Version. */
  getVersion(id: string, version: number): Hypothesis | undefined {
    const snapshot = this.store.hypothesisSnapshotAt(id, version);
    if (snapshot === undefined) return undefined;
    return HypothesisRepo.deserialize(JSON.parse(snapshot));
  }

  /** Alle Versionen einer Hypothese (aufsteigend) — vollständige Historie. */
  listVersions(id: string): Hypothesis[] {
    return this.store
      .hypothesisSnapshots(id)
      .map((snapshot) => HypothesisRepo.deserialize(JSON.parse(snapshot)));
  }

  private listByColumn(column: "task_id" | "cluster_id" | "plan_id", value: string): Hypothesis[] {
    // The header columns (hypotheses.task_id/cluster_id/plan_id) are the
    // AUTHORITATIVE provenance source; the immutable version snapshot keeps the
    // creation-state value (often null, since bindToTask only updates the
    // header — see its doc). Overlay the queried provenance onto the returned
    // object so it never contradicts the predicate it was found by.
    const field = column === "task_id" ? "taskId" : column === "cluster_id" ? "clusterId" : "planId";
    return this.store
      .hypothesisIdsByColumn(column, value)
      .map((hid) => this.get(hid))
      .filter((h): h is Hypothesis => !!h)
      .map((h) => ({ ...h, [field]: value }));
  }

  listByTask(taskId: string): Hypothesis[] {
    return this.listByColumn("task_id", taskId);
  }

  listByCluster(clusterId: string): Hypothesis[] {
    return this.listByColumn("cluster_id", clusterId);
  }

  listByPlan(planId: string): Hypothesis[] {
    return this.listByColumn("plan_id", planId);
  }

  /**
   * Bindet eine bestehende Hypothese provenienzhalber an einen Task/Cluster.
   * Aktualisiert NUR die Header-Spalten (für listByTask/listByCluster) und lässt
   * die versionierten Snapshots unangetastet — Binden ist Provenienz, keine
   * inhaltliche Revision, erzeugt daher keine neue Version.
   *
   * Die Header-Spalte `hypotheses.task_id`/`cluster_id` ist damit die
   * AUTORITATIVE Verknüpfung; das `taskId`/`clusterId`-Feld im Snapshot bildet
   * bewusst nur den Erstellungszustand ab. Konsumenten, die über die Bindung
   * filtern, nutzen listByTask/listByCluster (die die autoritative Provenienz
   * überlagern), nicht das rohe Snapshot-Feld.
   */
  bindToTask(id: string, taskId: string, clusterId: string | null): void {
    this.store.bindHypothesisToTask(id, taskId, clusterId);
  }

  /** Neueste (rich) Hypothese, die an einen Task gebunden ist — für das Gate. */
  latestForTask(taskId: string): Hypothesis | undefined {
    const rows = this.listByTask(taskId);
    return rows.length ? rows[rows.length - 1] : undefined;
  }
}
