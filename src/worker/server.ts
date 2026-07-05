#!/usr/bin/env node
import { redact } from "../runtime/redaction.js";
import { executeWorkerRequest } from "./operations.js";

const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_200_000) throw new Error("Worker-Request überschreitet 2,2 MiB");
    chunks.push(buffer);
}

let requestId = "unknown";
try {
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof request?.requestId === "string") requestId = request.requestId;
    const data = await executeWorkerRequest(request, (line) => {
        process.stdout.write(`${JSON.stringify({ frame: "event", requestId, line })}\n`);
    });
    process.stdout.write(`${JSON.stringify({ frame: "result", requestId, ok: true, data })}\n`);
} catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    process.stdout.write(`${JSON.stringify({
        frame: "result",
        requestId,
        ok: false,
        error: { code: "TARGET_PROTOCOL", message },
    })}\n`);
    process.exitCode = 1;
}
