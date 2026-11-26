/**
 * createCodeRunner: the one-call entry point for plugins and other in-process
 * consumers that already have tool functions (no MCP needed).
 */
import type { ExecuteResult, ResolvedProvider } from "@cloudflare/codemode";
import { QuickJSExecutor, type QuickJSExecutorOptions } from "./executor/quickjs-executor.ts";
import { createAuditLog, withPolicy, type AuditRecord, type ToolPolicy } from "./policy.ts";
import { SANDBOX_HELPERS } from "./helpers.ts";

type Fn = (args: unknown) => Promise<unknown> | unknown;

export interface CodeRunnerOptions {
  /** Tool functions by namespace, e.g. { crm: { getCustomer }, mail: { send } }. */
  tools: Record<string, Record<string, Fn>>;
  policy: ToolPolicy;
  executor?: QuickJSExecutorOptions;
}

export interface CodeRunResult extends ExecuteResult {
  audit: AuditRecord[];
  durationMs: number;
}

export interface CodeRunner {
  run(code: string): Promise<CodeRunResult>;
}

export function createCodeRunner(o: CodeRunnerOptions): CodeRunner {
  const executor = new QuickJSExecutor({ ...o.executor, preludes: [SANDBOX_HELPERS, ...(o.executor?.preludes ?? [])] });
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
