#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Desktop installation is global. Repositories are selected and validated per
// orchestration request, never through installation-time configuration.
delete process.env.ORCH_PROJECT_DIR;
await import(pathToFileURL(resolve(import.meta.dirname, "server.mjs")).href);
