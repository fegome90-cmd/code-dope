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
  newQuickJSWASMModule,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type {
  ExecuteResult,
  Executor,
  ResolvedProvider,
} from "../types.ts";
import { normalizeCode } from "../vendor/cf-normalize.ts";
import { sanitizeToolName } from "../vendor/cf-utils.ts";

// One WASM module per process, replaced whenever a run leaves it in a bad
// state (e.g. a guest stack overflow aborts JS_FreeRuntime). A module that
// failed to clean up is never reused.
let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModule();
  return modulePromise;
}
function discardModule(m: QuickJSWASMModule): void {
  void modulePromise?.then((cur) => {
    if (cur === m) modulePromise = null;
  });
}

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

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  // Bridge/wrapper internals and JS keywords matching IDENT
  "__cd_host",
  "__cd_log",
  "__r",
  "console",
  "globalThis",
  "helpers",
  "arguments",
  "await",
  "async",
  "yield",
  "eval",
  // Prototype-mutating and inherited Object.prototype keys
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  // Core ECMAScript globals
  "JSON",
  "Object",
  "Proxy",
  "Promise",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Array",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "Date",
  "Function",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Math",
  "Number",
  "BigInt",
  "RegExp",
  "Reflect",
  "String",
  "Symbol",
  "Intl",
  "Atomics",
  "Infinity",
  "NaN",
  "undefined",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
]);

const FALLBACK_OOM_JSON = '{"ok":false,"error":"Tool result exceeded sandbox memory limit"}';

function allocString(vm: QuickJSContext, str: string): QuickJSHandle {
  const h = vm.newString(str);
  if (vm.typeof(h) === "string") return h;
  // QTS_NewString returns JS_EXCEPTION on QuickJS memoryLimitBytes OOM without throwing in JS.
  h.dispose();
  throw new Error("out of memory");
}

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
      maxPendingCalls: options.maxPendingCalls ?? 64,
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

    const QuickJS = await getModule();
    let poisoned = false;
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.#o.memoryLimitBytes);
    runtime.setMaxStackSize(this.#o.maxStackBytes);
    const deadline = Date.now() + this.#o.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const vm = runtime.newContext();

    let disposed = false;
    const pending = new Set<QuickJSDeferredPromise>();
    let timer: NodeJS.Timeout | undefined;
    let abortExec!: (err: unknown) => void;
    const aborted = new Promise<{ abortError: string }>((res) => {
      abortExec = (e) => {
        disposed = true;
        res({ abortError: errMsg(e) });
      };
    });

    const pump = () => {
      if (disposed) return;
      const r = runtime.executePendingJobs();
      if (r.error) r.error.dispose();
    };

    let stringifyHandle: QuickJSHandle | undefined;
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
      // Types advertise sanitized names (e.g. get-user → get_user); resolve them back.
      const aliases = new Map(
        providers.map((p) => {
          const m = new Map<string, string>();
          const dup = new Set<string>();
          for (const k of Object.keys(p.fns)) {
            const a = sanitizeToolName(k);
            if (a === k) continue;
            if (m.has(a) || Object.hasOwn(p.fns, a)) dup.add(a);
            else m.set(a, k);
          }
          for (const d of dup) m.delete(d);
          return [p.name, m];
        }),
      );
      const hostFn = vm.newFunction("__cd_host", (provH, toolH, argsH) => {
        const prov = vm.getString(provH);
        const tool = vm.getString(toolH);
        const argsJson = vm.getString(argsH);
        const deferred = vm.newPromise();
        if (pending.size >= this.#o.maxPendingCalls) {
          let h: QuickJSHandle | undefined;
          try {
            h = allocString(
              vm,
              JSON.stringify({
                ok: false,
                error: `Too many concurrent tool calls (limit ${this.#o.maxPendingCalls}); use helpers.parallel with a concurrency limit`,
              }),
            );
            deferred.resolve(h);
          } catch (err) {
            try { deferred.dispose(); } catch { poisoned = true; }
            abortExec(err);
            return vm.undefined;
          } finally {
            h?.dispose();
          }
          const handle = deferred.handle;
          queueMicrotask(() => {
            try {
              pump();
            } catch (e) {
              if (!disposed) abortExec(e);
            }
          });
          return handle;
        }
        pending.add(deferred);
        const settle = (envelope: unknown) => {
          if (disposed) return;
          let text: string;
          try {
            text = JSON.stringify(envelope) ?? '{"ok":true}';
          } catch (e) {
            text = JSON.stringify({ ok: false, error: `Tool result is not JSON-serializable: ${errMsg(e)}` });
          }
          let resolvedOk = false;
          let lastErr: unknown;
          let h: QuickJSHandle | undefined;
          try {
            h = allocString(vm, text);
            deferred.resolve(h);
            resolvedOk = true;
            pending.delete(deferred);
          } catch (err) {
            lastErr = err;
          } finally {
            h?.dispose();
          }
          if (!resolvedOk) {
            let fh: QuickJSHandle | undefined;
            try {
              fh = allocString(vm, FALLBACK_OOM_JSON);
              deferred.resolve(fh);
              resolvedOk = true;
              pending.delete(deferred);
            } catch (fallbackErr) {
              lastErr = fallbackErr;
            } finally {
              fh?.dispose();
            }
          }
          if (!resolvedOk) {
            pending.delete(deferred);
            try { deferred.dispose(); } catch { poisoned = true; }
            abortExec(lastErr);
            return;
          }
          try {
            pump();
          } catch (pumpErr) {
            if (!disposed) abortExec(pumpErr);
          }
        };
        (async () => {
          const fns = byName.get(prov);
          const key = fns && Object.hasOwn(fns, tool) ? tool : aliases.get(prov)?.get(tool);
          if (!fns || key === undefined || typeof fns[key] !== "function") {
            throw new Error(`Unknown tool: ${prov}.${tool}`);
          }
          const args = argsJson === "" ? undefined : JSON.parse(argsJson);
          return fns[key](args);
        })()
          .then(
            (value) => settle({ ok: true, value: value === undefined ? null : value }),
            (e) => settle({ ok: false, error: errMsg(e) }),
          )
          .catch((e) => {
            if (!disposed) abortExec(e);
          });
        return deferred.handle;
      });
      vm.setProp(vm.global, "__cd_host", hostFn);
      hostFn.dispose();

      const setup = `(() => {
  const globalObj = globalThis;
  const hasOwn = Object.hasOwn;
  const reflectHas = Reflect.has;
  const apply = Reflect.apply;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const Err = Error;
  const MakeProxy = Proxy;
  const Str = String;
  const arrMap = Array.prototype.map;
  const arrJoin = Array.prototype.join;
  const host = globalObj.__cd_host, log = globalObj.__cd_log;
  delete globalObj.__cd_host; delete globalObj.__cd_log;
  const fmt = (a) => apply(arrJoin, apply(arrMap, a, [(x) => typeof x === "string" ? x : (() => { try { return stringify(x); } catch { return Str(x); } })()]), [" "]);
  globalObj.console = { log: (...a) => log("log", fmt(a)), info: (...a) => log("info", fmt(a)), warn: (...a) => log("warn", fmt(a)), error: (...a) => log("error", fmt(a)) };
  for (const name of ${JSON.stringify(providers.map((p) => p.name))}) {
    if (reflectHas(globalObj, name)) throw new Err("Invalid provider name: " + name);
    const target = {};
    globalObj[name] = new MakeProxy(target, {
      get(t, key) {
        if (hasOwn(t, key)) return t[key];
        if (typeof key !== "string" || key === "then") return undefined;
        return async (args) => {
          const env = parse(await host(name, key, args === undefined ? "" : stringify(args)));
          if (!env.ok) throw new Err(env.error);
          return env.value;
        };
      },
    });
  }
})();`;
      const evalPrelude = (src: string) => {
        const r = vm.evalCode(src, "prelude.js");
        if (r.error) {
          const err = vm.dump(r.error);
          r.error.dispose();
          const msg = errMsg(err);
          poisoned ||= msg === "" || msg === "undefined";
          if (msg.startsWith("Invalid provider name: ")) throw new Error(msg);
          throw new Error(`Prelude failed: ${msg}`);
        }
        r.value.dispose();
      };
      evalPrelude(setup);

      const jsonHandle = vm.getProp(vm.global, "JSON");
      try {
        stringifyHandle = vm.getProp(jsonHandle, "stringify");
      } finally {
        jsonHandle.dispose();
      }

      for (const src of [...this.#o.preludes, ...providers.map((p) => p.prelude ?? "").filter(Boolean)]) {
        evalPrelude(src);
      }

      const normalized = normalizeCode(code);
      const program = `(async () => await (${normalized}\n)())()`;
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
      const outcome = await Promise.race([resolved, timeout, aborted]);
      if (outcome === "timeout") {
        return { result: undefined, error: `Execution timed out after ${this.#o.timeoutMs}ms`, logs };
      }
      if ("abortError" in outcome) {
        return { result: undefined, error: outcome.abortError, logs };
      }
      if (outcome.error) {
        let err: unknown;
        try {
          err = vm.dump(outcome.error);
        } finally {
          outcome.error.dispose();
        }
        const msg = errMsg(err);
        return { result: undefined, error: /interrupted/i.test(msg) ? `Execution timed out after ${this.#o.timeoutMs}ms (interrupted)` : msg, logs };
      }
      try {
        if (vm.typeof(outcome.value) === "undefined") {
          return { result: undefined, logs };
        }
        if (!stringifyHandle) {
          throw new Error("Missing serializer handle");
        }
        const serialized = vm.callFunction(stringifyHandle, vm.undefined, outcome.value);
        if (serialized.error) {
          let err: unknown;
          try {
            err = vm.dump(serialized.error);
          } finally {
            serialized.error.dispose();
          }
          return { result: undefined, error: errMsg(err), logs };
        }
        try {
          if (vm.typeof(serialized.value) === "undefined") {
            return { result: undefined, error: "Result is not JSON-serializable", logs };
          }
          const text = vm.getString(serialized.value);
          const result: unknown = JSON.parse(text);
          try {
            JSON.stringify(result); // downstream hosts will serialize it again
          } catch {
            return { result: undefined, error: "Result is too deeply nested to serialize; flatten it before returning", logs };
          }
          return { result, logs };
        } finally {
          serialized.value.dispose();
        }
      } finally {
        outcome.value.dispose();
      }
    } catch (e) {
      return { result: undefined, error: errMsg(e), logs };
    } finally {
      if (timer) clearTimeout(timer);
      disposed = true;
      for (const d of pending) {
        try { d.dispose(); } catch { poisoned = true; }
      }
      try { stringifyHandle?.dispose(); } catch { poisoned = true; }
      try { vm.dispose(); } catch { poisoned = true; }
      try { runtime.dispose(); } catch { poisoned = true; }
      if (poisoned) discardModule(QuickJS);
    }
  }
}
