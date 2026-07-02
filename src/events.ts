import type { CommandRecord, CodexUsage, SliceResult, SliceType } from "./types.js";

/**
 * Parser für den Codex-JSONL-Stream (CLI >= 0.138, Thread-Format).
 * Beobachtete Eventtypen: thread.started, turn.started, item.started,
 * item.completed (item.type: command_execution | agent_message | reasoning |
 * file_change | mcp_tool_call | todo_list), turn.completed, turn.failed, error.
 */

export interface ParsedStream {
  threadId: string | null;
  agentMessages: string[];
  commands: CommandRecord[];
  usage: CodexUsage | null;
  turnFailed: boolean;
  errorMessage: string | null;
  rawEventCount: number;
}

export interface ReportDiscrepancy {
  reported_cmd: string;
  matched_command: string;
  exit_code: number;
}

function normalizeCommand(command: string): string {
  let normalized = command.toLowerCase().replace(/`/g, "").replace(/\s+/g, " ").trim();
  const wrapper = normalized.match(
    /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:l?c|cl)\s+(.+)$/,
  );
  if (wrapper) {
    normalized = wrapper[1].trim();
    const quote = normalized[0];
    if ((quote === "\"" || quote === "'") && normalized.at(-1) === quote) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  return normalized;
}

/**
 * Erkennt widersprüchliche Pass-Meldungen anhand der zuletzt ausgeführten,
 * passenden Kommandoaufzeichnung. Fehlende Aufzeichnungen bleiben unbekannt.
 */
export function detectReportDiscrepancies(
  sliceResult: SliceResult,
  commands: CommandRecord[],
): ReportDiscrepancy[] {
  const discrepancies: ReportDiscrepancy[] = [];

  for (const test of sliceResult.testsRun) {
    if (test.result !== "pass") continue;
    const reported = normalizeCommand(test.cmd);
    if (!reported) continue;
    const prefix = reported.length >= 20 ? reported.slice(0, 20) : null;
    let matched: CommandRecord | undefined;

    for (let i = commands.length - 1; i >= 0; i--) {
      const executed = normalizeCommand(commands[i].command);
      if (executed.includes(reported) || (prefix !== null && executed.includes(prefix))) {
        matched = commands[i];
        break;
      }
    }

    if (matched && typeof matched.exit_code === "number" && matched.exit_code !== 0) {
      discrepancies.push({
        reported_cmd: test.cmd,
        matched_command: matched.command,
        exit_code: matched.exit_code,
      });
    }
  }

  return discrepancies;
}

export function parseStreamLines(lines: Iterable<string>): ParsedStream {
  const out: ParsedStream = {
    threadId: null,
    agentMessages: [],
    commands: [],
    usage: null,
    turnFailed: false,
    errorMessage: null,
    rawEventCount: 0,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    out.rawEventCount++;
    const type: string = ev.type ?? "";

    switch (type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") out.threadId = ev.thread_id;
        break;
      case "item.completed": {
        const item = ev.item ?? {};
        if (item.type === "agent_message" && typeof item.text === "string") {
          out.agentMessages.push(item.text);
        } else if (item.type === "command_execution") {
          out.commands.push({
            command: String(item.command ?? ""),
            exit_code: typeof item.exit_code === "number" ? item.exit_code : null,
            output: String(item.aggregated_output ?? ""),
          });
        }
        break;
      }
      case "turn.completed":
        if (ev.usage) out.usage = ev.usage as CodexUsage;
        break;
      case "turn.failed":
        out.turnFailed = true;
        out.errorMessage = ev.error?.message ?? "turn.failed";
        break;
      case "error":
        // Reconnect-Rauschen ignorieren; nur harte Fehler als Message halten.
        if (typeof ev.message === "string" && !/Reconnecting/i.test(ev.message)) {
          out.errorMessage = ev.message;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

const SLICE_TYPES: SliceType[] = ["checkpoint", "submission", "blocker"];

/**
 * Extrahiert den SLICE_RESULT-Block (Plan §5.3) aus der letzten Agent-Message.
 * Toleriert Markdown-Codefences und fehlende Felder; parsed=false, wenn kein
 * erkennbarer Block vorliegt.
 */
export function parseSliceResult(agentText: string): SliceResult {
  const raw = agentText ?? "";
  const empty: SliceResult = {
    type: "checkpoint",
    cluster: null,
    doneInSlice: [],
    changedFiles: [],
    testsRun: [],
    openItems: [],
    nextStep: [],
    blockerText: null,
    parsed: false,
    raw,
  };

  const idx = raw.indexOf("SLICE_RESULT");
  if (idx === -1) return empty;
  const body = raw.slice(idx).replace(/```/g, "");
  const lines = body.split(/\r?\n/);

  const result: SliceResult = { ...empty, parsed: true };
  type Section =
    | "none"
    | "done"
    | "changed"
    | "tests"
    | "open"
    | "next"
    | "blocker";
  let section: Section = "none";

  const bulletOf = (l: string): string | null => {
    const m = l.match(/^\s*[-*]\s+(.*\S)\s*$/);
    return m ? m[1] : null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    const typeMatch = trimmed.match(/^Type\s*:\s*(\w+)/i);
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase() as SliceType;
      if (SLICE_TYPES.includes(t)) result.type = t;
      section = "none";
      continue;
    }
    const clusterMatch = trimmed.match(/^Cluster\s*:\s*(.+\S)/i);
    if (clusterMatch) {
      result.cluster = clusterMatch[1].trim();
      section = "none";
      continue;
    }
    if (/^Done in this slice\s*:/i.test(trimmed)) { section = "done"; continue; }
    if (/^Changed files\s*:/i.test(trimmed)) { section = "changed"; continue; }
    if (/^Tests run\s*:/i.test(trimmed)) { section = "tests"; continue; }
    if (/^Open items\s*:/i.test(trimmed)) { section = "open"; continue; }
    if (/^Next planned step\s*:/i.test(trimmed)) { section = "next"; continue; }
    if (/^BLOCKER_OR_QUESTION/i.test(trimmed)) { section = "blocker"; result.blockerText = ""; continue; }

    if (section === "blocker") {
      result.blockerText = (result.blockerText ?? "") + line + "\n";
      continue;
    }

    const bullet = bulletOf(line);
    if (!bullet) continue;
    switch (section) {
      case "done": result.doneInSlice.push(bullet); break;
      case "changed": result.changedFiles.push(bullet); break;
      case "tests": {
        const m = bullet.match(/^(.*?):\s*(pass|fail|skipped)\s*$/i);
        if (m) result.testsRun.push({ cmd: m[1].trim(), result: m[2].toLowerCase() });
        else result.testsRun.push({ cmd: bullet, result: "unknown" });
        break;
      }
      case "open": result.openItems.push(bullet); break;
      case "next": result.nextStep.push(bullet); break;
      default: break;
    }
    void lower;
  }

  if (result.blockerText) result.blockerText = result.blockerText.trim();
  return result;
}
