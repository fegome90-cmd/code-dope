import type { Executor } from "../types.ts";
import { PooledWorkerExecutor, type PooledWorkerExecutorOptions } from "./pool-executor.ts";
export type Isolation = "worker" | "pool" | "inline";
/**
 * Default executor with helpers preloaded.
 * "worker" (default): fresh worker thread per execution — host stays responsive, hard kill on timeout.
 * "pool": same isolation, but pre-warmed workers are reused (recycled after any error and after maxUses).
 *         Call `close()` on the returned PooledWorkerExecutor to stop it; idle workers never keep the process alive.
 * "inline": same thread, ~25x lower start-up cost, but a CPU-bound guest blocks the event loop until its deadline.
 */
export declare function createDefaultExecutor(isolation: "pool", options?: PooledWorkerExecutorOptions): PooledWorkerExecutor;
export declare function createDefaultExecutor(isolation?: Isolation, options?: PooledWorkerExecutorOptions): Executor;
