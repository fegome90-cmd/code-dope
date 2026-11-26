import type { ExecuteOptions, ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";
import type { QuickJSExecutorOptions } from "./quickjs-executor.ts";
import { type Fns } from "./worker-bridge.ts";
export interface WorkerExecutorOptions extends QuickJSExecutorOptions {
    /** V8 old-generation limit for the worker thread, in MB. Default 128. */
    workerHeapMb?: number;
    /** Extra time after timeoutMs before the worker is terminated. Default 1_000. */
    killGraceMs?: number;
}
export declare const WORKER_ENTRY: URL;
export declare class WorkerExecutor implements Executor {
    #private;
    constructor(options?: WorkerExecutorOptions);
    execute(code: string, providersOrFns: ResolvedProvider[] | Fns, options?: ExecuteOptions): Promise<ExecuteResult>;
}
