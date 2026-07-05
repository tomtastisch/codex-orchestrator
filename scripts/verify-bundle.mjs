import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-orchestrator-bundle-"));
const candidate = join(temporaryDirectory, "server.mjs");

try {
    await build({
        entryPoints: ["src/server.ts"],
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        outfile: candidate,
        external: ["node:*"],
        banner: {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
        logLevel: "silent",
    });

    const expected = readFileSync("bundle/server.mjs");
    const actual = readFileSync(candidate);
    if (!expected.equals(actual)) {
        console.error("bundle/server.mjs is stale; run npm run bundle and commit the result");
        process.exitCode = 1;
    }
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
