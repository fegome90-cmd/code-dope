import type { ExecuteResult, Executor, ResolvedProvider } from "../types.ts";
export interface QuickJSExecutorOptions {
    /** Wall-clock limit for the whole execution, including waits on tools. Default 30_000. */
    timeoutMs?: number;
    /** QuickJS heap limit in bytes. Default 32 MiB. */
    memoryLimitBytes?: number;
    /** QuickJS stack limit in bytes. Default 512 KiB. */
    maxStackBytes?: number;
    /** Maximum captured console lines. Default 200. */
    maxLogLines?: number;
    /** Maximum characters per console line. Default 2_000. */
    maxLogLineChars?: number;
    /** Maximum tool calls in flight at once inside one execution. Default 64. */
    maxPendingCalls?: number;
    /**
     * Trusted JavaScript evaluated in the guest before user code, after the
     * provider namespaces exist (e.g. `SANDBOX_HELPERS` from ../helpers.ts).
     */
    preludes?: string[];
}
type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;
export declare class QuickJSExecutor implements Executor {
    #private;
    constructor(options?: QuickJSExecutorOptions);
    execute(code: string, providersOrFns: ResolvedProvider[] | Fns): Promise<ExecuteResult>;
}
export {};
