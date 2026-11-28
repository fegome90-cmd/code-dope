/**
 * createCodeRunner: the one-call entry point for plugins and other in-process
 * consumers that already have tool functions (no MCP needed).
 */
import type { ExecuteResult, ResolvedProvider } from "./types.ts";
import { createDefaultExecutor, type Isolation } from "./executor/default.ts";
import type { PooledWorkerExecutorOptions } from "./executor/pool-executor.ts";
import { createAuditLog, withPolicy, type AuditRecord, type ToolPolicy } from "./policy.ts";

type Fn = (args: unknown) => Promise<unknown> | unknown;

export interface CodeRunnerOptions {
  /** Tool functions by namespace, e.g. { crm: { getCustomer }, mail: { send } }. */
  tools: Record<string, Record<string, Fn>>;
  policy: ToolPolicy;
  executor?: PooledWorkerExecutorOptions;
  /** Default "worker". */
  isolation?: Isolation;
}

export interface CodeRunResult extends ExecuteResult {
  audit: AuditRecord[];
  durationMs: number;
}

export interface CodeRunner {
  run(code: string): Promise<CodeRunResult>;
  /**
   * Closes this runner permanently and disposes its internally owned executor if supported.
   *
   * Idempotent: concurrent or repeated calls return the same promise. Sets terminal state
   * synchronously so subsequent `run()` calls fail closed with `"CodeRunner is closed"`.
   * Under `isolation: "pool"`, terminates active/queued workers and awaits cleanup; under
   * `"worker"` or `"inline"`, resolves immediately without cancelling in-flight runs.
   */
  close(): Promise<void>;
}

export function createCodeRunner(o: CodeRunnerOptions): CodeRunner {
  const executor = createDefaultExecutor(o.isolation, o.executor);
  const providers: ResolvedProvider[] = Object.entries(o.tools).map(([name, fns]) => ({
    name,
    fns: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, async (a: unknown) => f(a)])),
  }));
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    async run(code) {
      if (closed) {
        return { result: undefined, error: "CodeRunner is closed", logs: [], audit: [], durationMs: 0 };
      }
      const log = createAuditLog();
      const userAudit = o.policy.audit;
      const guarded = withPolicy(executor, {
        ...o.policy,
        audit: (r) => {
          log.sink(r);
          if (userAudit) {
            try {
              void Promise.resolve(userAudit(r)).catch(() => {});
            } catch {
              /* sink-owned delivery failure */
            }
          }
        },
      });
      const t = Date.now();
      const r = await guarded.execute(code, providers);
      return { ...r, audit: log.records, durationMs: Date.now() - t };
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = "close" in executor && typeof executor.close === "function"
        ? Promise.resolve((executor as { close: () => Promise<void> }).close())
        : Promise.resolve();
      return closing;
    },
  };
}
