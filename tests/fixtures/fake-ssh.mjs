#!/usr/bin/env node
import { spawn } from "node:child_process";

const workerEntry = process.argv.at(-1);
const child = spawn(process.execPath, [workerEntry], { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
});
