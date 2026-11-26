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
import { providerSpecs, runCall, toProviders } from "./worker-bridge.js";
export const WORKER_ENTRY = new URL(import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js", import.meta.url);
export class WorkerExecutor {
    #o;
    constructor(options = {}) {
        this.#o = options;
    }
    execute(code, providersOrFns, options) {
        if (options?.connectors?.length) {
            return Promise.resolve({ result: undefined, error: "WorkerExecutor does not support connector bindings", logs: [] });
        }
        const providers = toProviders(providersOrFns);
        const { workerHeapMb = 128, killGraceMs = 1_000, ...quickjs } = this.#o;
        const timeoutMs = quickjs.timeoutMs ?? 30_000;
        return new Promise((resolve) => {
            let settled = false;
            const worker = new Worker(WORKER_ENTRY, {
                workerData: { mode: "once", code, providers: providerSpecs(providers), options: { ...quickjs, timeoutMs } },
                env: {},
                stderr: true, // capture emscripten abort noise instead of inheriting it
                resourceLimits: { maxOldGenerationSizeMb: workerHeapMb },
            });
            worker.stderr.resume();
            const finish = (r) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(kill);
                void worker.terminate();
                resolve(r);
            };
            const kill = setTimeout(() => finish({ result: undefined, error: `Execution timed out after ${timeoutMs}ms (worker terminated)`, logs: [] }), timeoutMs + killGraceMs);
            const byName = new Map(providers.map((p) => [p.name, p.fns]));
            worker.on("message", async (m) => {
                if (m.type === "done")
                    return finish(m.result);
                const reply = await runCall(byName, m);
                if (!settled)
                    worker.postMessage(reply);
            });
            worker.on("error", (e) => finish({ result: undefined, error: `Sandbox worker failed: ${e.message}`, logs: [] }));
            worker.on("exit", (c) => finish({ result: undefined, error: `Sandbox worker exited (code ${c})`, logs: [] }));
        });
    }
}
