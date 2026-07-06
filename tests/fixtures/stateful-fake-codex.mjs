#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const authPath = join(codexHome, "auth.json");
const authenticated = () => existsSync(authPath) && readFileSync(authPath).length > 0;

if (args[0] === "--version") {
    process.stdout.write("codex-cli 9.9.9\n");
    process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
    if (authenticated()) {
        process.stdout.write("Logged in using ChatGPT\n");
        process.exit(0);
    }
    process.stderr.write("Not logged in\n");
    process.exit(1);
}

if (args[0] === "login" && args[1] === "--with-access-token") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const token = Buffer.concat(chunks);
    if (token.length === 0) process.exit(2);
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, token, { mode: 0o600 });
    token.fill(0);
    process.exit(0);
}

if (args[0] === "exec") {
    if (!authenticated()) {
        process.stderr.write("Not logged in\n");
        process.exit(1);
    }
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
        process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "stateful-thread" })}\n`);
        process.stdout.write(`${JSON.stringify({
            type: "item.completed",
            item: {
                type: "agent_message",
                text: [
                    "SLICE_RESULT",
                    "Type: submission",
                    "Cluster: C-REMOTE",
                    "Done in this slice:",
                    "- remote auth observed",
                    "Changed files:",
                    "- none",
                    "Tests run:",
                    "- auth: pass",
                    "Open items:",
                    "- none",
                    "Next planned step:",
                    "- done",
                ].join("\n"),
            },
        })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
    });
} else {
    process.stderr.write(`unsupported stateful fake Codex args: ${args.join(" ")}\n`);
    process.exit(2);
}
