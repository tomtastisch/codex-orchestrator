import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-orchestrator-bundle-"));
try {
    for (const name of ["server", "worker"]) {
        const candidate = join(temporaryDirectory, `${name}.mjs`);
        await build({
            entryPoints: [`src/${name === "server" ? "server.ts" : "worker/server.ts"}`],
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

        const expected = readFileSync(`bundle/${name}.mjs`);
        const actual = readFileSync(candidate);
        if (!expected.equals(actual)) {
            console.error(`bundle/${name}.mjs is stale; run npm run bundle and commit the result`);
            process.exitCode = 1;
        }
    }
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
