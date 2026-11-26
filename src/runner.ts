/**
 * createCodeRunner: the one-call entry point for plugins and other in-process
 * consumers that already have tool functions (no MCP needed).
 */
import type { ExecuteResult, ResolvedProvider } from "@cloudflare/codemode";
import { createDefaultExecutor, type Isolation } from "./executor/default.ts";
import type { WorkerExecutorOptions } from "./executor/worker-executor.ts";
import { createAuditLog, withPolicy, type AuditRecord, type ToolPolicy } from "./policy.ts";

type Fn = (args: unknown) => Promise<unknown> | unknown;

export interface CodeRunnerOptions {
  /** Tool functions by namespace, e.g. { crm: { getCustomer }, mail: { send } }. */
  tools: Record<string, Record<string, Fn>>;
  policy: ToolPolicy;
  executor?: WorkerExecutorOptions;
  /** Default "worker". */
  isolation?: Isolation;
}

export interface CodeRunResult extends ExecuteResult {
  audit: AuditRecord[];
  durationMs: number;
}

export interface CodeRunner {
  run(code: string): Promise<CodeRunResult>;
}

export function createCodeRunner(o: CodeRunnerOptions): CodeRunner {
  const executor = createDefaultExecutor(o.isolation, o.executor);
  const providers: ResolvedProvider[] = Object.entries(o.tools).map(([name, fns]) => ({
    name,
    fns: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, async (a: unknown) => f(a)])),
  }));
  return {
    async run(code) {
      const log = createAuditLog();
      const userAudit = o.policy.audit;
      const guarded = withPolicy(executor, {
        ...o.policy,
        audit: (r) => {
          log.sink(r);
          userAudit?.(r);
        },
      });
      const t = Date.now();
      const r = await guarded.execute(code, providers);
      return { ...r, audit: log.records, durationMs: Date.now() - t };
    },
  };
}
