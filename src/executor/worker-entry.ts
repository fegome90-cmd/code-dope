/**
 * Worker side of WorkerExecutor / PooledWorkerExecutor: runs QuickJSExecutor;
 * tool calls are forwarded to the parent thread.
 *  - mode "once": run the job in workerData, post "done", the parent terminates us.
 *  - mode "pool": warm up the WASM module, post "ready", then run jobs received
 *    by message, one at a time. Every job gets a fresh QuickJS runtime/context.
 *    When retired cleanly, close the parent port and let the worker exit.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { ExecuteResult } from "../types.ts";
import { QuickJSExecutor, type QuickJSExecutorOptions } from "./quickjs-executor.ts";
import type { ProviderSpec, ReplyMsg } from "./worker-bridge.ts";

interface Init { mode: "once" | "pool"; options: QuickJSExecutorOptions; code?: string; providers?: ProviderSpec[] }
interface JobMsg { type: "job"; job: number; code: string; providers: ProviderSpec[] }
interface ShutdownMsg { type: "shutdown" }

const init = workerData as Init;
if (init.mode === "pool") {
  // Parent does not capture our stderr (that would pin its event loop); drop emscripten abort noise here.
  process.stderr.write = (() => true) as typeof process.stderr.write;
}
const port = parentPort!;
const executor = new QuickJSExecutor(init.options);
let nextId = 0;
let currentJob = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function proxies(specs: ProviderSpec[], job: number) {
  return specs.map((p) => ({
    name: p.name,
    prelude: p.prelude,
    fns: Object.fromEntries(
      p.tools.map((tool) => [
        tool,
        (args: unknown) =>
          new Promise((resolve, reject) => {
            const id = ++nextId;
            waiting.set(id, { resolve, reject });
            port.postMessage({ type: "call", job, id, provider: p.name, tool, args });
          }),
      ]),
    ),
  }));
}

async function run(job: number, code: string, specs: ProviderSpec[]): Promise<ExecuteResult> {
  currentJob = job;
  try {
    return await executor.execute(code, proxies(specs, job));
  } finally {
    waiting.clear(); // calls left unanswered belong to a finished job; their replies are dropped
  }
}

port.on("message", (m: ReplyMsg | JobMsg | ShutdownMsg) => {
  if (m.type === "shutdown") {
    port.close();
    return;
  }
  if (m.type === "job") {
    void run(m.job, m.code, m.providers).then((result) => port.postMessage({ type: "done", job: m.job, result }));
    return;
  }
  if (m.job !== undefined && m.job !== currentJob) return;
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.value);
  else w.reject(new Error(m.error));
});

if (init.mode === "once") {
  const result = await run(0, init.code!, init.providers!);
  port.postMessage({ type: "done", result });
} else {
  const warm = await executor.execute("async () => 0", []); // load + compile the WASM module before taking jobs
  port.postMessage(warm.error ? { type: "failed", error: warm.error } : { type: "ready" });
}
