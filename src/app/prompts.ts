import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
server.registerPrompt(
  "codex_orchestrator",
  {
    title: "Codex Orchestrator",
    description: "Plan and supervise a Codex implementation through gated clusters.",
    argsSchema: {
      request: z.string().min(1).max(20_000),
      repo_path: z.string()
        .min(1)
        .optional()
        .describe("Exact absolute Git repository root; omit only when Claude should ask the user."),
    },
  },
  ({ request, repo_path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Run orchestrator_doctor first. Then decompose this request into gated clusters, " +
          "form explicit hypotheses, delegate bounded slices to Codex, review every result " +
          "and confirm only after declared checks pass. " +
          (repo_path
            ? `Use this exact absolute Git repository root for repo_path: ${repo_path}. `
            : "Ask the user for the exact absolute Git repository root before calling cluster_plan; never infer it. ") +
          `Request: ${request}`,
      },
    }],
  }),
);

server.registerPrompt(
  "orchestrator_status",
  {
    title: "Orchestrator Status",
    description: "Load the durable state of an orchestration plan.",
    argsSchema: {
      plan_id: z.string().optional(),
    },
  },
  ({ plan_id }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: plan_id
          ? `Call plan_snapshot for plan ${plan_id}, then summarize cluster, task, review and check status without changing state.`
          : "Identify the current plan from available task events, call plan_snapshot and summarize status without changing state.",
      },
    }],
  }),
);
}
