import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { Store, type TaskRow, newId } from "./db.js";
import { startSlice } from "./codex.js";
import { buildFirstSlicePrompt, buildResumeSlicePrompt } from "./prompts.js";
import { ensureAgentsMd } from "./agents.js";
import { detectReportDiscrepancies } from "./events.js";
import type { Effort, Sandbox, SliceOutcome } from "./types.js";

interface Control {
  pauseRequested: boolean;
  cancelRequested: boolean;
  abort: AbortController | null;
  looping: boolean;
}

interface StartArgs {
  clusterId: string | null;
  repoPath: string;
  worktree: string | null;
  branch: string | null;
  instructions: string;
  acceptance: string[];
  sandbox: Sandbox;
  model: string;
  effort: Effort;
  network: boolean;
  maxMinutes: number;
  extraConfig?: Record<string, string>;
  hypothesisId?: string | null;
}

/**
 * Session-Manager: Slice-Loop, Resume, Steuerung, Limits, Watchdog.
 * MCP ist pull-basiert; hier läuft die Arbeit im Hintergrund, Claude pollt
 * über task_wait/task_events (Plan §2.1, §5).
 */
export class SessionManager {
  private controls = new Map<string, Control>();
  private emitter = new EventEmitter();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private store: Store) {
    this.emitter.setMaxListeners(0);
  }

  /**
   * Beim Serverstart: NUR Tasks toter Prozesse als failed markieren (Reaper).
   * Tasks, deren owner_pid ein lebender Prozess ist (z. B. eine parallele
   * Instanz eines anderen Projekts, die sich denselben Store teilt), bleiben
   * unangetastet — verhindert Cross-Kill zwischen gleichzeitigen Projekten.
   */
  reapOnStartup(): number {
    const running = this.store
      .listTasks()
      .filter((t) => t.status === "running" || t.status === "awaiting_resume");
    let n = 0;
    for (const t of running) {
      if (t.owner_pid && t.owner_pid !== process.pid && isProcessAlive(t.owner_pid)) {
        continue; // gehört einer lebenden Instanz -> nicht anfassen
      }
      // Verwaisten Codex-OS-Prozess terminieren (Plan §11), falls noch am Leben.
      if (t.codex_pid && isProcessAlive(t.codex_pid)) {
        try { process.kill(t.codex_pid, "SIGTERM"); } catch { /* schon weg */ }
      }
      this.store.updateTask(t.id, { status: "failed", ended_at: new Date().toISOString(), codex_pid: null });
      this.store.addEvent(t.id, "task_status", {
        status: "failed",
        reason: `Reaper: verwaister Prozess (owner_pid=${t.owner_pid ?? "?"}, codex_pid=${t.codex_pid ?? "?"}) nach Restart/Crash. Resume via task_control.`,
      });
      n++;
    }
    return n;
  }

  /** F: Bei Server-Shutdown alle laufenden Codex-Kinder terminieren (SIGTERM). */
  shutdown(): number {
    let n = 0;
    for (const [, c] of this.controls) {
      if (c.abort) {
        c.cancelRequested = true;
        try { c.abort.abort(); } catch { /* ignore */ }
        n++;
      }
    }
    return n;
  }

  private ctrl(taskId: string): Control {
    let c = this.controls.get(taskId);
    if (!c) {
      c = { pauseRequested: false, cancelRequested: false, abort: null, looping: false };
      this.controls.set(taskId, c);
    }
    return c;
  }

  private async acquire(): Promise<void> {
    if (this.active < config.parallelism.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.active++;
  }
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  createTask(args: StartArgs): TaskRow {
    const id = newId("T");
    return this.store.createTask({
      id,
      cluster_id: args.clusterId,
      codex_session_id: null,
      worktree: args.worktree,
      branch: args.branch,
      repo_path: args.repoPath,
      sandbox: args.sandbox,
      model: args.model,
      effort: args.effort,
      instructions: args.instructions,
      acceptance_json: JSON.stringify(args.acceptance),
      max_minutes: args.maxMinutes,
      network: args.network ? 1 : 0,
      status: "queued",
      extra_config_json: args.extraConfig ? JSON.stringify(args.extraConfig) : null,
      owner_pid: null,
      hypothesis_id: args.hypothesisId ?? null,
    });
  }

  /** Startet (oder setzt fort) den Hintergrund-Slice-Loop für einen Task. */
  startLoop(taskId: string, stopCondition: string | null): void {
    const c = this.ctrl(taskId);
    if (c.looping) return;
    c.looping = true;
    c.pauseRequested = false;
    c.cancelRequested = false;
    void this.loop(taskId, stopCondition).finally(() => {
      c.looping = false;
    });
  }

  private acceptanceOf(task: TaskRow): string[] {
    try {
      return task.acceptance_json ? (JSON.parse(task.acceptance_json) as string[]) : [];
    } catch {
      return [];
    }
  }

  private elapsedMinutes(task: TaskRow): number {
    if (!task.started_at) return 0;
    return (Date.now() - Date.parse(task.started_at)) / 60000;
  }

  private async loop(taskId: string, stopCondition: string | null): Promise<void> {
    const c = this.ctrl(taskId);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let task = this.store.getTask(taskId);
      if (!task) return;

      if (c.cancelRequested) {
        this.finish(taskId, "cancelled", "vom Orchestrator abgebrochen");
        return;
      }
      // Limits (Plan §11).
      if (task.slice_count >= config.limits.maxSlicesPerTask) {
        this.limitBreach(taskId, `max_slices (${config.limits.maxSlicesPerTask}) erreicht`);
        return;
      }
      if (!task.started_at) {
        this.store.updateTask(taskId, { started_at: new Date().toISOString() });
        task = this.store.getTask(taskId)!;
      } else if (this.elapsedMinutes(task) > config.limits.maxTaskMinutes) {
        this.limitBreach(taskId, `max_task_minutes (${config.limits.maxTaskMinutes}) überschritten`);
        return;
      }

      const isFirst = !task.codex_session_id;
      const workDir = task.worktree || task.repo_path;
      if (isFirst) {
        // Codex hat IMMER seine Executor-AGENTS.md vorliegen.
        try {
          const a = ensureAgentsMd(workDir);
          if (a.action !== "present") {
            this.store.addEvent(taskId, "note", { agents_md: a.action, path: a.path });
          }
        } catch { /* best effort */ }
      }
      const acceptance = this.acceptanceOf(task);
      const injections = isFirst ? [] : this.store.pendingInjections(taskId);
      const prompt = isFirst
        ? buildFirstSlicePrompt(task, acceptance, stopCondition)
        : buildResumeSlicePrompt(task, injections, acceptance);

      await this.acquire();
      // Cancel, der während der Semaphor-Wartezeit eintraf, sofort respektieren.
      if (c.cancelRequested) {
        this.release();
        this.finish(taskId, "cancelled", "abgebrochen vor Slice-Start");
        return;
      }
      const abort = new AbortController();
      c.abort = abort;
      // owner_pid stempeln: identifiziert die Instanz, die diesen Slice fährt.
      this.store.updateTask(taskId, { status: "running", owner_pid: process.pid });
      this.emit(taskId);

      let outcome: SliceOutcome;
      try {
        const timeoutMs = task.max_minutes * 60_000 + config.limits.sliceKillGraceMs;
        let extraConfig: Record<string, string> | undefined;
        try {
          extraConfig = task.extra_config_json ? JSON.parse(task.extra_config_json) : undefined;
        } catch { extraConfig = undefined; }
        const running = startSlice({
          repoPath: workDir,
          threadId: task.codex_session_id,
          prompt,
          sandbox: task.sandbox as Sandbox,
          model: task.model,
          effort: task.effort as Effort,
          network: task.network === 1,
          extraConfig,
          timeoutMs,
          signal: abort.signal,
          // H: Live-Fortschritt (Kommandos) sofort persistieren -> task_wait reagiert mid-slice.
          onLine: (line) => this.persistLiveEvent(taskId, line),
        });
        // E: Codex-OS-PID für den Reaper festhalten.
        if (running.child.pid) this.store.updateTask(taskId, { codex_pid: running.child.pid });
        outcome = await running.done;
      } finally {
        this.release();
        c.abort = null;
        this.store.updateTask(taskId, { codex_pid: null });
      }

      // B: Injektionen NUR bei sauberem Abschluss als ausgeliefert markieren.
      // Bei killed/failed bleiben sie pending und werden im nächsten Resume erneut geliefert.
      if (injections.length && outcome.status === "normal") {
        this.store.markInjectionsDelivered(injections.map((i) => i.id));
        for (const inj of injections) {
          this.store.addEvent(taskId, "injection_delivered", { priority: inj.priority, message: inj.message });
        }
      }

      const sr = outcome.sliceResult;
      const discrepancies = detectReportDiscrepancies(sr, outcome.commands);
      const integrityOk = discrepancies.length === 0;
      const integrity = integrityOk
        ? { integrity_ok: true }
        : { integrity_ok: false, discrepancies };
      if (!integrityOk) {
        this.store.addEvent(taskId, "report_discrepancy", { discrepancies });
      }
      const summary = summarize(sr, outcome);
      this.store.addEvent(taskId, "slice_message", { text: (outcome.agentMessages.at(-1) ?? "").slice(0, 4000) });
      this.store.updateTask(taskId, {
        codex_session_id: outcome.threadId,
        slice_count: task.slice_count + 1,
        last_slice_type: sr.type,
        last_summary: summary,
      });

      if (outcome.status === "killed") {
        if (c.cancelRequested) {
          this.finish(taskId, "cancelled", "abgebrochen (cancel)");
          return;
        }
        // C: Budget-Kill = kein sauberer Abschluss. NICHT blind resumen (Schleifen-/
        // inkonsistenter-Session-Risiko), sondern als Entscheidungspunkt an Claude:
        // blocked. Resume ist dann ein bewusster task_control(resume)-Schritt.
        this.store.addEvent(taskId, "slice_killed", { reason: outcome.errorMessage });
        this.store.addEvent(taskId, "slice_result", {
          type: "checkpoint", parsed: false, cluster: sr.cluster,
          done: sr.doneInSlice, changed_files: sr.changedFiles, tests: sr.testsRun,
          open_items: sr.openItems, next_step: sr.nextStep, blocker: null, usage: outcome.usage,
          ...integrity,
        });
        this.finish(taskId, "blocked", "Slice-Budget überschritten (killed). Entscheidung nötig: resume mit größerem Budget oder replan.");
        return;
      } else if (outcome.status === "failed") {
        this.store.addEvent(taskId, "slice_error", { error: outcome.errorMessage });
        this.finish(taskId, "failed", outcome.errorMessage ?? "Slice fehlgeschlagen");
        return;
      }

      this.store.addEvent(taskId, "slice_result", {
        type: sr.type,
        parsed: sr.parsed,
        cluster: sr.cluster,
        done: sr.doneInSlice,
        changed_files: sr.changedFiles,
        tests: sr.testsRun,
        open_items: sr.openItems,
        next_step: sr.nextStep,
        blocker: sr.blockerText,
        usage: outcome.usage,
        ...integrity,
      });
      this.emit(taskId);

      // Terminale Slice-Typen.
      if (outcome.status === "normal" && sr.type === "submission") {
        if (!integrityOk) {
          this.finish(taskId, "blocked", "Ein als pass gemeldeter Check lief mit einem Exit-Code ungleich 0. Die Submission ist nicht vertrauenswürdig und benötigt eine Prüfung durch den Orchestrator.");
          return;
        }
        this.finish(taskId, "completed", "submission");
        return;
      }
      if (outcome.status === "normal" && sr.type === "blocker") {
        this.finish(taskId, "blocked", "blocker");
        return;
      }

      // Checkpoint: pausieren oder weiterlaufen.
      if (c.pauseRequested) {
        c.pauseRequested = false;
        this.store.updateTask(taskId, { status: "paused" });
        this.store.addEvent(taskId, "task_status", { status: "paused" });
        this.emit(taskId);
        return;
      }
      this.store.updateTask(taskId, { status: "awaiting_resume" });
      // Schleife läuft direkt weiter (nächster Slice via Resume).
    }
  }

  private finish(taskId: string, status: TaskRow["status"], reason: string): void {
    this.store.updateTask(taskId, { status, ended_at: new Date().toISOString() });
    this.store.addEvent(taskId, "task_status", { status, reason });
    this.emit(taskId);
  }

  private limitBreach(taskId: string, reason: string): void {
    this.store.updateTask(taskId, { status: "blocked", ended_at: new Date().toISOString() });
    this.store.addEvent(taskId, "limit_breach", { reason });
    this.store.addEvent(taskId, "task_status", { status: "blocked", reason });
    this.emit(taskId);
  }

  // ---- Steuerung (task_control) ----
  pause(taskId: string): { ok: boolean; note: string } {
    const c = this.ctrl(taskId);
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, note: "unbekannter Task" };
    if (["completed", "failed", "cancelled", "blocked"].includes(task.status)) {
      return { ok: false, note: `Task ist terminal (${task.status})` };
    }
    c.pauseRequested = true;
    return { ok: true, note: "Pause angefordert; wirksam am nächsten Slice-Ende" };
  }

  resume(taskId: string): { ok: boolean; note: string } {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, note: "unbekannter Task" };
    if (["completed", "cancelled"].includes(task.status)) {
      return { ok: false, note: `Task ist terminal (${task.status})` };
    }
    if (!task.codex_session_id && task.status !== "queued") {
      return { ok: false, note: "keine Codex-Session zum Fortsetzen" };
    }
    this.startLoop(taskId, null);
    return { ok: true, note: "Loop (fort-)gesetzt" };
  }

  cancel(taskId: string): { ok: boolean; note: string } {
    const c = this.ctrl(taskId);
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, note: "unbekannter Task" };
    c.cancelRequested = true;
    if (c.abort) c.abort.abort();
    if (!c.looping) this.finish(taskId, "cancelled", "abgebrochen (nicht laufend)");
    return { ok: true, note: "Abbruch angefordert; Worktree bleibt für Forensik erhalten" };
  }

  inject(taskId: string, message: string, priority: string): { ok: boolean; id: string; note: string } {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, id: "", note: "unbekannter Task" };
    const id = this.store.addInjection(taskId, message, priority);
    return { ok: true, id, note: "Injektion in Queue; Auslieferung an nächster Slice-Grenze" };
  }

  /** H: Persistiert Kommando-Events live während des Slice (mid-slice-Observability). */
  private persistLiveEvent(taskId: string, line: string): void {
    const l = line.trim();
    if (!l.startsWith("{")) return;
    let ev: any;
    try { ev = JSON.parse(l); } catch { return; }
    if (ev.type === "item.completed" && ev.item?.type === "command_execution") {
      this.store.addEvent(taskId, "slice_command", {
        command: String(ev.item.command ?? ""),
        exit_code: typeof ev.item.exit_code === "number" ? ev.item.exit_code : null,
        output_tail: String(ev.item.aggregated_output ?? "").slice(-1200),
      });
      this.emit(taskId);
    }
  }

  // ---- Warten (task_wait) ----
  private emit(taskId: string): void {
    this.emitter.emit(taskId);
  }

  /**
   * Long-Poll: kehrt zurück, sobald ein Event mit seq>cursor vorliegt, der Task
   * terminal wird, oder das Timeout greift.
   */
  async wait(taskId: string, cursor: number, timeoutSec: number): Promise<{
    events: any[];
    cursor: number;
    task_status: string;
    timed_out: boolean;
  }> {
    const cap = Math.min(timeoutSec, config.maxWaitSeconds) * 1000;
    const deadline = Date.now() + cap;

    const snapshot = () => {
      const evs = this.store.eventsAfter(taskId, cursor);
      const task = this.store.getTask(taskId);
      return { evs, task };
    };

    let { evs, task } = snapshot();
    if (evs.length > 0 || !task) {
      return this.pack(taskId, evs, cursor, task?.status ?? "unknown", false);
    }

    // Auf neues Event oder Timeout warten.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.emitter.off(taskId, onEvent);
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      };
      const onEvent = () => done();
      const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      // Fallback-Poll (falls Emitter-Signal verpasst wird, z. B. anderer Prozess).
      const poll = setInterval(() => {
        if (this.store.maxSeq(taskId) > cursor) done();
        if (Date.now() >= deadline) done();
      }, 500);
      this.emitter.on(taskId, onEvent);
    });

    ({ evs, task } = snapshot());
    const timedOut = evs.length === 0;
    return this.pack(taskId, evs, cursor, task?.status ?? "unknown", timedOut);
  }

  private pack(taskId: string, evs: any[], cursor: number, status: string, timedOut: boolean) {
    const events = evs.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      kind: e.kind,
      payload: safeParse(e.payload_json),
    }));
    const newCursor = events.length ? events[events.length - 1].seq : cursor;
    return { events, cursor: newCursor, task_status: status, timed_out: timedOut };
  }

  /** Wartet bis zu einer Bedingung (für task_start wait_for). */
  async waitUntil(
    taskId: string,
    predicate: (status: string, sawSliceResult: boolean) => boolean,
    maxSec: number,
  ): Promise<void> {
    const deadline = Date.now() + maxSec * 1000;
    let cursor = 0;
    let sawSliceResult = false;
    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const r = await this.wait(taskId, cursor, Math.min(remaining, config.maxWaitSeconds));
      cursor = r.cursor;
      if (r.events.some((e) => e.kind === "slice_result")) sawSliceResult = true;
      if (predicate(r.task_status, sawSliceResult)) return;
      if (["completed", "failed", "cancelled", "blocked", "paused"].includes(r.task_status)) return;
    }
  }
}

function summarize(sr: import("./types.js").SliceResult, outcome: SliceOutcome): string {
  const parts = [`[${sr.type}]`];
  if (sr.doneInSlice.length) parts.push(`done: ${sr.doneInSlice.length} item(s)`);
  if (sr.changedFiles.length) parts.push(`files: ${sr.changedFiles.length}`);
  if (sr.testsRun.length) parts.push(`tests: ${sr.testsRun.map((t) => t.result).join(",")}`);
  if (outcome.status !== "normal") parts.push(`status: ${outcome.status}`);
  return parts.join(" ");
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Prüft, ob ein Prozess mit gegebener PID lebt (Signal 0 wirft nicht bei Existenz). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = existiert, aber keine Rechte -> gilt als lebend.
    return e?.code === "EPERM";
  }
}
