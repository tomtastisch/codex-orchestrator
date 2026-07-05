import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { TargetError } from "../execution/errors.js";

export function assertAllowedPath(allowedRoot: string, cwd: string): string {
    const root = realpathSync(resolve(allowedRoot));
    const candidate = realpathSync(resolve(cwd));
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        throw new TargetError("TARGET_REPOSITORY", "Repository-Pfad liegt außerhalb der erlaubten Wurzel", "remote");
    }
    return candidate;
}
