import type { TaskRow } from "./ports/persistence.js";

/** Verbindliches Slice-Abschlussformat (Plan §5.3). */
export const SLICE_RESULT_SPEC = `
When you stop working for this slice, end your final message with EXACTLY this block
(plain text, no code fences):

SLICE_RESULT
Type: checkpoint | submission | blocker
Cluster: <cluster id or ->
Done in this slice:
- ...
Changed files:
- ...
Tests run:
- <cmd>: pass|fail|skipped
Open items:
- ...
Next planned step:
- ...

Rules:
- Type: submission ONLY when the acceptance criteria are fully met and verified.
- Type: blocker when you are missing information or hit an obstacle you must not
  improvise around. In that case append a full BLOCKER_OR_QUESTION section after the
  block describing: context, the concrete question/blocker, options you see, and your
  recommendation. Never guess around missing information.
- Type: checkpoint otherwise (progress made, more work remains).
- "Changed files" must list every file you created or modified in this slice.
`.trim();

export function buildFirstSlicePrompt(task: TaskRow, acceptance: string[], stopCondition: string | null): string {
  const acc = acceptance.length
    ? acceptance.map((a) => `- ${a}`).join("\n")
    : "- (none specified)";
  return [
    `You are Codex, the implementation executor in a supervised, cluster-based workflow.`,
    `An orchestrator (Claude) delegates bounded work slices to you and reviews the result.`,
    ``,
    `Cluster: ${task.cluster_id ?? "-"}`,
    `Slice budget: about ${task.max_minutes} minutes of focused work, then checkpoint.`,
    task.sandbox === "read-only"
      ? `Sandbox: read-only. Do NOT modify files; analyse/investigate/review only.`
      : `Sandbox: workspace-write. You may modify files within the working directory.`,
    stopCondition ? `Stop condition: ${stopCondition}` : ``,
    ``,
    `Task instructions:`,
    task.instructions,
    ``,
    `Acceptance criteria:`,
    acc,
    ``,
    SLICE_RESULT_SPEC,
  ].filter((l) => l !== undefined).join("\n");
}

export function buildResumeSlicePrompt(
  task: TaskRow,
  injections: { message: string; priority: string }[],
  acceptance: string[],
): string {
  const parts: string[] = [];
  if (injections.length) {
    parts.push(`## Orchestrator injections (highest priority — read first)`);
    for (const inj of injections) {
      parts.push(`- [${inj.priority}] ${inj.message}`);
    }
    parts.push(``);
  }
  parts.push(`Continue the task from where you left off. Respect the slice budget of`);
  parts.push(`about ${task.max_minutes} minutes, then produce a SLICE_RESULT.`);
  if (acceptance.length) {
    parts.push(``);
    parts.push(`Reminder — acceptance criteria:`);
    parts.push(acceptance.map((a) => `- ${a}`).join("\n"));
  }
  parts.push(``);
  parts.push(SLICE_RESULT_SPEC);
  return parts.join("\n");
}
