import type { Executor } from "@cloudflare/codemode";
import { QuickJSExecutor } from "./quickjs-executor.ts";
import { WorkerExecutor, type WorkerExecutorOptions } from "./worker-executor.ts";
import { PooledWorkerExecutor, type PooledWorkerExecutorOptions } from "./pool-executor.ts";
import { SANDBOX_HELPERS } from "../helpers.ts";

export type Isolation = "worker" | "pool" | "inline";

/**
 * Default executor with helpers preloaded.
 * "worker" (default): fresh worker thread per execution — host stays responsive, hard kill on timeout.
 * "pool": same isolation, but pre-warmed workers are reused (recycled after any error and after maxUses).
 *         Call `close()` on the returned PooledWorkerExecutor to stop it; idle workers never keep the process alive.
 * "inline": same thread, ~25x lower start-up cost, but a CPU-bound guest blocks the event loop until its deadline.
 */
export function createDefaultExecutor(isolation: "pool", options?: PooledWorkerExecutorOptions): PooledWorkerExecutor;
export function createDefaultExecutor(isolation?: Isolation, options?: PooledWorkerExecutorOptions): Executor;
export function createDefaultExecutor(isolation: Isolation = "worker", options: PooledWorkerExecutorOptions = {}): Executor {
  const o = { ...options, preludes: [SANDBOX_HELPERS, ...(options.preludes ?? [])] };
  if (isolation === "inline") return new QuickJSExecutor(o);
  if (isolation === "pool") return new PooledWorkerExecutor(o);
  const { size: _s, maxUses: _m, idleMs: _i, prewarm: _p, ...worker } = o;
  return new WorkerExecutor(worker satisfies WorkerExecutorOptions);
}
