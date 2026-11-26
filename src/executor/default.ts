import type { Executor } from "@cloudflare/codemode";
import { QuickJSExecutor } from "./quickjs-executor.ts";
import { WorkerExecutor, type WorkerExecutorOptions } from "./worker-executor.ts";
import { SANDBOX_HELPERS } from "../helpers.ts";

export type Isolation = "worker" | "inline";

/**
 * Default executor with helpers preloaded.
 * "worker" (default): fresh worker thread per execution — host stays responsive, hard kill on timeout.
 * "inline": same thread, ~25x lower start-up cost, but a CPU-bound guest blocks the event loop until its deadline.
 */
export function createDefaultExecutor(isolation: Isolation = "worker", options: WorkerExecutorOptions = {}): Executor {
  const o = { ...options, preludes: [SANDBOX_HELPERS, ...(options.preludes ?? [])] };
  return isolation === "inline" ? new QuickJSExecutor(o) : new WorkerExecutor(o);
}
