#!/usr/bin/env node
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const configured = process.env.ORCH_PROJECT_DIR;
if (!configured || !isAbsolute(configured)) {
    throw new Error("ORCH_PROJECT_DIR must be an absolute path");
}

const project = resolve(configured);
let isDirectory = false;
try {
    isDirectory = lstatSync(project).isDirectory();
} catch {
    // Fail with one stable, non-sensitive message for missing/inaccessible paths.
}
if (!isDirectory) {
    throw new Error("ORCH_PROJECT_DIR must be a directory");
}

process.chdir(project);
await import(pathToFileURL(resolve(import.meta.dirname, "server.mjs")).href);
