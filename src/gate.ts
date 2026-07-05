/**
 * Pflicht-Hypothesen-Gate (Cluster 2).
 *
 * Kein Codex-Agentenjob darf ohne eine verknüpfte, existierende Hypothese
 * starten. Die Prüfung ist als reine Funktion herausgezogen, damit sie ohne
 * MCP-Server/Codex direkt testbar ist. `task_start` ruft sie vor der
 * Task-Erstellung auf und blockiert bei Verstoß mit verständlicher Meldung.
 */
import type { HypothesisRepo, Hypothesis } from "./hypotheses.js";

export interface GateInput {
  hypothesisId?: string | null;
}

export interface GateResult {
  ok: boolean;
  error?: string;
  hypothesis?: Hypothesis;
}

const MISSING_MSG =
  "Start blockiert: Für jeden Codex-Agentenjob ist zwingend eine Hypothese erforderlich. " +
  "Bilde zuerst eine Hypothese (hypotheses → create: initialAssumption, criticalQuestions, " +
  "falsificationPlan, confidenceBefore) und übergib deren id als 'hypothesis_id' an task_start.";

/**
 * Prüft, ob ein Task starten darf.
 * @param require Wenn false, wird das Gate übersprungen (Kompatibilitäts-/
 *                Notausstieg via ORCH_REQUIRE_HYPOTHESIS=false).
 */
export function checkHypothesisGate(
  repo: HypothesisRepo,
  input: GateInput,
  require: boolean,
): GateResult {
  if (!require) return { ok: true };
  const id = input.hypothesisId?.trim();
  if (!id) {
    return { ok: false, error: MISSING_MSG };
  }
  const h = repo.get(id);
  if (!h) {
    return {
      ok: false,
      error:
        `Start blockiert: hypothesis_id '${id}' existiert nicht. ` +
        "Lege die Hypothese zuerst an (hypotheses → create) oder korrigiere die id.",
    };
  }
  return { ok: true, hypothesis: h };
}
