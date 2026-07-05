import type { TargetErrorCode } from "./types.js";

export class TargetError extends Error {
    constructor(
        public readonly code: TargetErrorCode,
        message: string,
        public readonly targetId: string,
        public readonly retryable = false,
    ) {
        super(message);
        this.name = "TargetError";
    }
}
