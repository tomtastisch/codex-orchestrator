#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
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

const canonicalProject = realpathSync(project);
const git = spawnSync("git", ["-C", canonicalProject, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    shell: false,
});
if (git.status !== 0 || realpathSync(git.stdout.trim()) !== canonicalProject) {
    throw new Error("ORCH_PROJECT_DIR must be a Git repository root");
}

process.chdir(canonicalProject);
await import(pathToFileURL(resolve(import.meta.dirname, "server.mjs")).href);
