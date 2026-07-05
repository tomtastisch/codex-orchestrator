#!/usr/bin/env node

const args = process.argv.slice(2);

if (args[0] === "--version") {
    process.stdout.write("codex-cli 9.9.9\n");
    process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
    process.stdout.write("Logged in using ChatGPT\n");
    process.exit(0);
}

if (args[0] === "login" && args[1] === "--with-access-token") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.exit(input.length > 0 ? 0 : 2));
} else if (args[0] === "exec") {
    process.stdin.resume();
    process.stdin.on("end", () => {
        process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-thread" })}\n`);
        process.stdout.write(`${JSON.stringify({
            type: "item.completed",
            item: {
                type: "agent_message",
                text: [
                    "SLICE_RESULT",
                    "Type: submission",
                    "Cluster: C1",
                    "Done in this slice:",
                    "- fake completed",
                    "Changed files:",
                    "- none",
                    "Tests run:",
                    "- fake: pass",
                    "Open items:",
                    "- none",
                    "Next planned step:",
                    "- done",
                ].join("\n"),
            },
        })}\n`);
        process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
    });
    process.stdin.on("data", () => {});
} else {
    process.stderr.write(`unsupported fake Codex args: ${args.join(" ")}\n`);
    process.exit(2);
}
