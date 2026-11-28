/** Child-process fixture for tests/pool.test.ts: a pool that is never closed must not keep the process alive. */
import { PooledWorkerExecutor } from "../../src/index.ts";
const p = new PooledWorkerExecutor({ size: 1, idleMs: 0 });
const r = await p.execute("async () => { function f() { f(); } f(); }", {});
console.log(r.error ? "err" : "ok", (await p.execute("async () => 1", {})).result);
