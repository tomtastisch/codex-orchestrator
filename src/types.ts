/** Gemeinsame Typen für Store, Session-Manager und Tools. */

export type Sandbox = "read-only" | "workspace-write";
/** Reasoning effort. 'xhigh' = extra hoch (Codex gpt-5.x). */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** Eskalationsleiter für Effort (Plan §9: Effort ist der primäre Hebel). */
export const EFFORT_LADDER: Effort[] = ["low", "medium", "high", "xhigh"];

export function nextEffort(e: Effort): Effort {
  const i = EFFORT_LADDER.indexOf(e);
  return i < 0 || i === EFFORT_LADDER.length - 1 ? e : EFFORT_LADDER[i + 1];
}

export type ClusterStatus =
  | "planned"
  | "active"
  | "submitted"
  | "in_review"
  | "needs_changes"
  | "blocked"
  | "confirmed"
  | "replanning"
  | "cancelled";

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_resume"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type HypothesisStatus = "open" | "confirmed" | "rejected" | "superseded";

/** Vom Codex-Slice erwarteter Abschlussblock (Plan §5.3). */
export type SliceType = "checkpoint" | "submission" | "blocker";

export interface SliceResult {
  type: SliceType;
  cluster: string | null;
  doneInSlice: string[];
  changedFiles: string[];
  testsRun: { cmd: string; result: string }[];
  openItems: string[];
  nextStep: string[];
  /** Bei blocker: Rohtext des BLOCKER_OR_QUESTION-Blocks. */
  blockerText: string | null;
  /** Ob überhaupt ein wohlgeformter SLICE_RESULT-Block gefunden wurde. */
  parsed: boolean;
  /** Roh-Abschlussnachricht des Agenten (für Diagnose). */
  raw: string;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CommandRecord {
  command: string;
  exit_code: number | null;
  output: string;
}

/** Ergebnis eines einzelnen Codex-Slice (ein exec- oder resume-Aufruf). */
export interface SliceOutcome {
  threadId: string | null;
  agentMessages: string[];
  commands: CommandRecord[];
  usage: CodexUsage | null;
  sliceResult: SliceResult;
  /** normal = Turn sauber beendet; failed = Codex-Fehler; killed = Budget/Cancel. */
  status: "normal" | "failed" | "killed";
  errorMessage: string | null;
  rawEventCount: number;
}

export const EVENT_KINDS = [
  "slice_started",
  "slice_command",
  "slice_message",
  "slice_result",
  "report_discrepancy",
  "slice_error",
  "slice_killed",
  "injection_delivered",
  "task_status",
  "limit_breach",
  "note",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
