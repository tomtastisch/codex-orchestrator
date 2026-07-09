import { config } from "../config.js";
import { Store } from "../db.js";
import { SessionManager } from "../session.js";
import { ClusterStateMachine } from "../statemachine.js";
import { WorktreeManager } from "../worktree.js";
import { HypothesisRepo } from "../hypotheses.js";
import { createExecutionRuntime } from "../execution/registry.js";
import type { PersistenceStore } from "../ports/persistence.js";
import type { ExecutionTarget } from "../execution/types.js";

type ExecutionRuntime = ReturnType<typeof createExecutionRuntime>;

/** The MCP tool/prompt result envelope every handler returns. */
export interface ToolResponse {
    // The MCP SDK's CallToolResult carries an open index signature; mirror it so
    // these envelopes are assignable to the SDK handler return type.
    [x: string]: unknown;
    content: { type: "text"; text: string }[];
    isError?: boolean;
}

/**
 * Application wiring shared by every tool module: the composed singleton graph
 * plus the response helpers. The tool modules depend on this context and never
 * construct infrastructure themselves — that is the composition root's job
 * (`createAppContext`, called only from `server.ts`).
 */
export interface AppContext {
    store: PersistenceStore;
    execution: ExecutionRuntime;
    sessions: SessionManager;
    hypRepo: HypothesisRepo;
    machine: ClusterStateMachine;
    worktrees: WorktreeManager;
    ok: (obj: unknown) => ToolResponse;
    err: (obj: unknown) => ToolResponse;
    executionTargetForCluster: (clusterId: string) => ExecutionTarget;
}

/** Composition root: build the singleton graph and the response helpers. */
export function createAppContext(): AppContext {
    const store = new Store(config.dbPath);
    const execution = createExecutionRuntime(config);
    const sessions = new SessionManager(store, (id) => execution.registry.get(id));
    const hypRepo = new HypothesisRepo(store);
    const machine = new ClusterStateMachine(store);
    const worktrees = new WorktreeManager();

    const ok = (obj: unknown): ToolResponse => ({
        content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    });
    const err = (obj: unknown): ToolResponse => ({
        content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
        isError: true,
    });
    const executionTargetForCluster = (clusterId: string): ExecutionTarget => {
        const latest = store.listTasks({ clusterId }).at(-1);
        return execution.registry.get(latest?.target_id ?? "local");
    };

    return { store, execution, sessions, hypRepo, machine, worktrees, ok, err, executionTargetForCluster };
}
