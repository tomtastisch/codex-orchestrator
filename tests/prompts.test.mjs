import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("MCP exposes guided orchestration prompts independently of Claude Code", async () => {
    const orchHome = mkdtempSync(join(tmpdir(), "orch-prompts-"));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "bundle", "server.mjs")],
        env: { ...process.env, ORCH_HOME: orchHome },
        stderr: "pipe",
    });
    const client = new Client(
        { name: "prompt-contract-test", version: "1.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);
        const prompts = await client.listPrompts();
        assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [
            "codex_orchestrator",
            "orchestrator_status",
        ]);

        const rendered = await client.getPrompt({
            name: "codex_orchestrator",
            arguments: { request: "Add deterministic validation" },
        });
        assert.equal(rendered.messages[0]?.role, "user");
        assert.equal(rendered.messages[0]?.content.type, "text");
        assert.match(rendered.messages[0].content.text, /orchestrator_doctor/);
        assert.match(rendered.messages[0].content.text, /Add deterministic validation/);
        assert.match(rendered.messages[0].content.text, /Ask the user for the exact absolute Git repository root/);

        const withRepository = await client.getPrompt({
            name: "codex_orchestrator",
            arguments: {
                request: "Add deterministic validation",
                repo_path: "/tmp/example-repository",
            },
        });
        assert.match(withRepository.messages[0].content.text, /exact absolute Git repository root/);
        assert.match(withRepository.messages[0].content.text, /\/tmp\/example-repository/);

        await assert.rejects(
            client.getPrompt({
                name: "codex_orchestrator",
                arguments: {
                    request: "Add deterministic validation",
                    repo_path: "",
                },
            }),
            /at least 1 character|String must contain at least 1 character|Invalid arguments/i,
        );

        const status = await client.getPrompt({
            name: "orchestrator_status",
            arguments: { plan_id: "plan-123" },
        });
        assert.equal(status.messages[0]?.content.type, "text");
        assert.match(status.messages[0].content.text, /plan_snapshot/);
        assert.match(status.messages[0].content.text, /plan-123/);
    } finally {
        await client.close();
    }
});
