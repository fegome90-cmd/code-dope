import type { ExecuteOptions, ExecuteResult, Executor, ResolvedProvider } from "../types.ts";
import { type WorkerExecutorOptions } from "./worker-executor.ts";
import { type Fns } from "./worker-bridge.ts";
export interface PooledWorkerExecutorOptions extends WorkerExecutorOptions {
    /** Maximum number of workers (= concurrent executions). Extra executions queue FIFO. Default 2. */
    size?: number;
    /** Successful executions per worker before it is recycled. Default 100. */
    maxUses?: number;
    /** Idle workers are terminated after this many ms (0 = never). Default 30_000. */
    idleMs?: number;
    /** Pre-warm workers at construction and after recycling (except idle reaping). Default true. */
    prewarm?: boolean;
}
export interface PoolStats {
    spawned: number;
    alive: number;
    idle: number;
    busy: number;
    queued: number;
    warming: number;
}
export declare class PooledWorkerExecutor implements Executor {
    #private;
    constructor(options?: PooledWorkerExecutorOptions);
    get stats(): PoolStats;
    execute(code: string, providersOrFns: ResolvedProvider[] | Fns, options?: ExecuteOptions): Promise<ExecuteResult>;
    /** Terminates every worker. In-flight and queued executions resolve with an error. Idempotent. */
    close(): Promise<void>;
}
