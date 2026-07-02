import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const t = new StdioClientTransport({ command: "node", args: [join(process.cwd(), "bundle/server.mjs")],
  env: { ...process.env, ORCH_HOME: mkdtempSync(join(tmpdir(), "orch-bundle-")), ORCH_AUTO_UPDATE: "false" } });
const c = new Client({ name: "bundlecheck", version: "1" }, { capabilities: {} });
await c.connect(t);
const tools = (await c.listTools()).tools.map(x => x.name).sort();
console.log("tools:", tools.length, tools.join(","));
const r = await c.callTool({ name: "models_list", arguments: {} });
const d = JSON.parse(r.content[0].text);
console.log("models_list ok:", d.available_models.map(m => m.model).join(","));
await c.close();
console.log(tools.length >= 13 ? "=== BUNDLE OK ===" : "=== BUNDLE DEFEKT ===");
