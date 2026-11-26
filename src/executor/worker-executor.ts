/**
 * WorkerExecutor — runs each execution in a fresh worker thread that hosts a
 * QuickJSExecutor. Adds two properties the inline executor cannot give:
 *  - the host event loop keeps running while guest code burns CPU;
 *  - a hard kill (`worker.terminate()`) on timeout, and any WASM state the guest
 *    corrupted dies with the worker.
 * The worker gets an empty `env` (no inherited secrets) and V8 heap limits.
 * Tool functions (and their credentials) stay in the parent thread; the worker
 * only sends {provider, tool, args} messages and receives results.
 */
import { Worker } from "node:worker_threads";
import type { ExecuteOptions, ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";
import type { QuickJSExecutorOptions } from "./quickjs-executor.ts";

export interface WorkerExecutorOptions extends QuickJSExecutorOptions {
  /** V8 old-generation limit for the worker thread, in MB. Default 128. */
  workerHeapMb?: number;
  /** Extra time after timeoutMs before the worker is terminated. Default 1_000. */
  killGraceMs?: number;
}

type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;
const ENTRY = new URL("./worker-entry.ts", import.meta.url);

export class WorkerExecutor implements Executor {
  readonly #o: WorkerExecutorOptions;
  constructor(options: WorkerExecutorOptions = {}) {
    this.#o = options;
  }

  execute(code: string, providersOrFns: ResolvedProvider[] | Fns, options?: ExecuteOptions): Promise<ExecuteResult> {
    if (options?.connectors?.length) {
      return Promise.resolve({ result: undefined, error: "WorkerExecutor does not support connector bindings", logs: [] });
    }
    const providers: ResolvedProvider[] = Array.isArray(providersOrFns) ? providersOrFns : [{ name: "codemode", fns: providersOrFns }];
    const { workerHeapMb = 128, killGraceMs = 1_000, ...quickjs } = this.#o;
    const timeoutMs = quickjs.timeoutMs ?? 30_000;

    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      const worker = new Worker(ENTRY, {
        workerData: {
          code,
          providers: providers.map((p) => ({ name: p.name, tools: Object.keys(p.fns), prelude: p.prelude })),
          options: { ...quickjs, timeoutMs },
        },
        env: {},
        stderr: true, // capture emscripten abort noise instead of inheriting it
        resourceLimits: { maxOldGenerationSizeMb: workerHeapMb },
      });
      worker.stderr.resume();
      const finish = (r: ExecuteResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(kill);
        void worker.terminate();
        resolve(r);
      };
      const kill = setTimeout(
        () => finish({ result: undefined, error: `Execution timed out after ${timeoutMs}ms (worker terminated)`, logs: [] }),
        timeoutMs + killGraceMs,
      );
      const byName = new Map(providers.map((p) => [p.name, p.fns]));

      worker.on("message", async (m: { type: "call"; id: number; provider: string; tool: string; args: unknown } | { type: "done"; result: ExecuteResult }) => {
        if (m.type === "done") return finish(m.result);
        const fn = byName.get(m.provider)?.[m.tool];
        let reply: { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string };
        try {
          if (!fn) throw new Error(`Unknown tool: ${m.provider}.${m.tool}`);
          const value = await fn(m.args);
          reply = { type: "reply", id: m.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null") };
        } catch (e) {
          reply = { type: "reply", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!settled) worker.postMessage(reply);
      });
      worker.on("error", (e) => finish({ result: undefined, error: `Sandbox worker failed: ${e.message}`, logs: [] }));
      worker.on("exit", (c) => finish({ result: undefined, error: `Sandbox worker exited (code ${c})`, logs: [] }));
    });
  }
}
