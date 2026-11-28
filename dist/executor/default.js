import { QuickJSExecutor } from "./quickjs-executor.js";
import { WorkerExecutor } from "./worker-executor.js";
import { PooledWorkerExecutor } from "./pool-executor.js";
import { SANDBOX_HELPERS } from "../helpers.js";
export function createDefaultExecutor(isolation = "worker", options = {}) {
    const o = { ...options, preludes: [SANDBOX_HELPERS, ...(options.preludes ?? [])] };
    if (isolation === "inline")
        return new QuickJSExecutor(o);
    if (isolation === "pool")
        return new PooledWorkerExecutor(o);
    const { size: _s, maxUses: _m, idleMs: _i, prewarm: _p, ...worker } = o;
    return new WorkerExecutor(worker);
}
