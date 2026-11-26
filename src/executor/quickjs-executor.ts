/**
 * QuickJSExecutor — a Node.js implementation of Cloudflare's codemode `Executor`
 * contract (packages/codemode/src/executor-types.ts @ 841b6fc).
 *
 * Why it exists: @cloudflare/codemode ships only DynamicWorkerExecutor
 * (Cloudflare Workers) and IframeSandboxExecutor (browser). Its `./mcp` entry
 * loads in Node and accepts any Executor, so this file is the only missing
 * piece to run Code Mode inside a Node MCP server or plugin.
 *
 * Isolation model:
 *  - Guest code runs in QuickJS compiled to WebAssembly (quickjs-emscripten).
 *    The guest has no `require`, `process`, `fetch`, filesystem, timers or
 *    network: those objects simply do not exist in the WASM realm.
 *  - Host functions are reached only through one bridge that carries JSON
 *    strings. No host object handle is ever passed into the guest, so the
 *    classic `this.constructor.constructor("return process")()` escape has
 *    nothing to climb.
 *  - Limits: wall-clock timeout (covers idle waits on tools), CPU interrupt
 *    deadline (covers `while(true){}`), memory limit, stack limit, log caps.
 *  - Credentials live in host fns; the guest only sees tool results.
 *
 * QuickJS is not audited (author statement in its README). Treat this as
 * defence in depth, not a hardened boundary: run hostile workloads in a
 * separate process/container as well.
 */
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type {
  ExecuteResult,
  Executor,
  ResolvedProvider,
} from "@cloudflare/codemode";
import { normalizeCode } from "../vendor/cf-normalize.ts";

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
  /**
   * Trusted JavaScript evaluated in the guest before user code, after the
   * provider namespaces exist (e.g. `SANDBOX_HELPERS` from ../helpers.ts).
   */
  preludes?: string[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(["__cd_host", "__cd_log", "console", "globalThis", "helpers"]);

type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;

function toProviders(p: ResolvedProvider[] | Fns): ResolvedProvider[] {
  return Array.isArray(p) ? p : [{ name: "codemode", fns: p }];
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export class QuickJSExecutor implements Executor {
  readonly #o: Required<QuickJSExecutorOptions>;

  constructor(options: QuickJSExecutorOptions = {}) {
    this.#o = {
      timeoutMs: options.timeoutMs ?? 30_000,
      memoryLimitBytes: options.memoryLimitBytes ?? 32 * 1024 * 1024,
      maxStackBytes: options.maxStackBytes ?? 512 * 1024,
      maxLogLines: options.maxLogLines ?? 200,
      maxLogLineChars: options.maxLogLineChars ?? 2_000,
      preludes: options.preludes ?? [],
    };
  }

  async execute(code: string, providersOrFns: ResolvedProvider[] | Fns): Promise<ExecuteResult> {
    const logs: string[] = [];
    let providers: ResolvedProvider[];
    try {
      providers = toProviders(providersOrFns);
      for (const p of providers) {
        if (!IDENT.test(p.name) || RESERVED.has(p.name)) throw new Error(`Invalid provider name: ${p.name}`);
      }
    } catch (e) {
      return { result: undefined, error: errMsg(e), logs };
    }

    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.#o.memoryLimitBytes);
    runtime.setMaxStackSize(this.#o.maxStackBytes);
    const deadline = Date.now() + this.#o.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const vm = runtime.newContext();

    let disposed = false;
    const pending = new Set<QuickJSDeferredPromise>();
    let timer: NodeJS.Timeout | undefined;

    const pump = () => {
      if (disposed) return;
      const r = runtime.executePendingJobs();
      if (r.error) r.error.dispose();
    };

    try {
      // console bridge: strings only, capped.
      const logFn = vm.newFunction("__cd_log", (levelH, msgH) => {
        if (logs.length >= this.#o.maxLogLines) return;
        const level = vm.getString(levelH);
        let msg = vm.getString(msgH);
        if (msg.length > this.#o.maxLogLineChars) msg = msg.slice(0, this.#o.maxLogLineChars) + "…[truncated]";
        logs.push(level === "log" ? msg : `[${level}] ${msg}`);
      });
      vm.setProp(vm.global, "__cd_log", logFn);
      logFn.dispose();

      // tool bridge: (provider, tool, argsJson) -> Promise<envelopeJson>
      const byName = new Map(providers.map((p) => [p.name, p.fns]));
      const hostFn = vm.newFunction("__cd_host", (provH, toolH, argsH) => {
        const prov = vm.getString(provH);
        const tool = vm.getString(toolH);
        const argsJson = vm.getString(argsH);
        const deferred = vm.newPromise();
        pending.add(deferred);
        const settle = (envelope: unknown) => {
          if (disposed) return;
          pending.delete(deferred);
          let text: string;
          try {
            text = JSON.stringify(envelope) ?? '{"ok":true}';
          } catch (e) {
            text = JSON.stringify({ ok: false, error: `Tool result is not JSON-serializable: ${errMsg(e)}` });
          }
          const h = vm.newString(text);
          deferred.resolve(h);
          h.dispose();
          pump();
        };
        (async () => {
          const fns = byName.get(prov);
          if (!fns || !Object.hasOwn(fns, tool) || typeof fns[tool] !== "function") {
            throw new Error(`Unknown tool: ${prov}.${tool}`);
          }
          const args = argsJson === "" ? undefined : JSON.parse(argsJson);
          return fns[tool](args);
        })().then(
          (value) => settle({ ok: true, value: value === undefined ? null : value }),
          (e) => settle({ ok: false, error: errMsg(e) }),
        );
        return deferred.handle;
      });
      vm.setProp(vm.global, "__cd_host", hostFn);
      hostFn.dispose();

      const setup = `(() => {
  const host = globalThis.__cd_host, log = globalThis.__cd_log;
  delete globalThis.__cd_host; delete globalThis.__cd_log;
  const fmt = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
  globalThis.console = { log: (...a) => log("log", fmt(a)), info: (...a) => log("info", fmt(a)), warn: (...a) => log("warn", fmt(a)), error: (...a) => log("error", fmt(a)) };
  for (const name of ${JSON.stringify(providers.map((p) => p.name))}) {
    const target = {};
    globalThis[name] = new Proxy(target, {
      get(t, key) {
        if (Object.prototype.hasOwnProperty.call(t, key)) return t[key];
        if (typeof key !== "string" || key === "then") return undefined;
        return async (args) => {
          const env = JSON.parse(await host(name, key, args === undefined ? "" : JSON.stringify(args)));
          if (!env.ok) throw new Error(env.error);
          return env.value;
        };
      },
    });
  }
})();`;
      const preludes = [setup, ...this.#o.preludes, ...providers.map((p) => p.prelude ?? "").filter(Boolean)];
      for (const src of preludes) {
        const r = vm.evalCode(src, "prelude.js");
        if (r.error) {
          const err = vm.dump(r.error);
          r.error.dispose();
          throw new Error(`Prelude failed: ${errMsg(err)}`);
        }
        r.value.dispose();
      }

      const normalized = normalizeCode(code);
      const program = `(async () => { const __r = await (${normalized})(); return __r === undefined ? "__cd_undefined__" : JSON.stringify(__r); })()`;
      const evaluated = vm.evalCode(program, "user-code.js");
      if (evaluated.error) {
        const err = vm.dump(evaluated.error);
        evaluated.error.dispose();
        return { result: undefined, error: errMsg(err), logs };
      }
      const promiseHandle: QuickJSHandle = evaluated.value;
      const resolved = vm.resolvePromise(promiseHandle);
      promiseHandle.dispose();
      pump();

      const timeout = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), Math.max(0, deadline - Date.now()));
      });
      const outcome = await Promise.race([resolved, timeout]);
      if (outcome === "timeout") {
        return { result: undefined, error: `Execution timed out after ${this.#o.timeoutMs}ms`, logs };
      }
      if (outcome.error) {
        const err = vm.dump(outcome.error);
        outcome.error.dispose();
        const msg = errMsg(err);
        return { result: undefined, error: /interrupted/i.test(msg) ? `Execution timed out after ${this.#o.timeoutMs}ms (interrupted)` : msg, logs };
      }
      const text = vm.getString(outcome.value);
      outcome.value.dispose();
      return { result: text === "__cd_undefined__" ? undefined : JSON.parse(text), logs };
    } catch (e) {
      return { result: undefined, error: errMsg(e), logs };
    } finally {
      if (timer) clearTimeout(timer);
      disposed = true;
      for (const d of pending) {
        try { d.dispose(); } catch { /* already gone */ }
      }
      try { vm.dispose(); } catch { /* leaked handles on abort; runtime freed below */ }
      try { runtime.dispose(); } catch { /* idem */ }
    }
  }
}
