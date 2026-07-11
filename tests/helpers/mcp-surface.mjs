import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Boots an MCP server bundle over stdio and returns its full external surface —
 * every tool (name, description, inputSchema) and prompt (name, description,
 * arguments), sorted by name. This is the contract consumers see; comparing two
 * bundles' surfaces proves interface parity independent of internal structure
 * or bundle bytes. Used both to regenerate the golden fixture from the base
 * branch and to assert the current bundle still matches it.
 */
export async function dumpSurface(bundlePath) {
    const transport = new StdioClientTransport({
        command: "node",
        args: [bundlePath],
        env: { ...process.env, ORCH_HOME: mkdtempSync(join(tmpdir(), "orch-surface-")), ORCH_AUTO_UPDATE: "false" },
    });
    const client = new Client({ name: "mcp-surface", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    try {
        const tools = (await client.listTools()).tools
            .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const prompts = (await client.listPrompts()).prompts
            .map((p) => ({ name: p.name, description: p.description ?? "", arguments: p.arguments ?? [] }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return { tools, prompts };
    } finally {
        await client.close();
    }
}
