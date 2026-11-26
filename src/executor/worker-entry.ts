/** Worker side of WorkerExecutor: runs QuickJSExecutor; tool calls are forwarded to the parent thread. */
import { parentPort, workerData } from "node:worker_threads";
import { QuickJSExecutor, type QuickJSExecutorOptions } from "./quickjs-executor.ts";

interface Job {
  code: string;
  providers: Array<{ name: string; tools: string[]; prelude?: string }>;
  options: QuickJSExecutorOptions;
}
const job = workerData as Job;
const port = parentPort!;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

port.on("message", (m: { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string }) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.value);
  else w.reject(new Error(m.error));
});

const providers = job.providers.map((p) => ({
  name: p.name,
  prelude: p.prelude,
  fns: Object.fromEntries(
    p.tools.map((tool) => [
      tool,
      (args: unknown) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          waiting.set(id, { resolve, reject });
          port.postMessage({ type: "call", id, provider: p.name, tool, args });
        }),
    ]),
  ),
}));

const result = await new QuickJSExecutor(job.options).execute(job.code, providers);
port.postMessage({ type: "done", result });
