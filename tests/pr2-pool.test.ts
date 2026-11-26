import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { PooledWorkerExecutor } from "../src/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) { assert.ok(Date.now() < deadline, "condition did not settle"); await sleep(10); }
}

test("closing a reserved ready slot resolves it without running a tool or waiting for the watchdog", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, idleMs: 0, timeoutMs: 5_000 });
  let calls = 0;
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    const pending = pool.execute("async () => codemode.read({})", { read: async () => { calls++; return 2; } });
    const closing = pool.close();
    const result = await Promise.race([pending, sleep(500).then(() => ({ error: "TEST_WAIT_EXPIRED" }))]);
    assert.match(result.error ?? "", /closed/i);
    assert.equal(calls, 0);
    await closing;
  } finally { await pool.close(); }
});

test("failed warmup does not replace workers without demand and queued calls receive startup errors", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, idleMs: 0, preludes: ['throw new Error("CONTROLLED_STARTUP_FAILURE")'] });
  try {
    await until(() => pool.stats.alive === 0);
    assert.equal(pool.stats.spawned, 1);
    await sleep(120);
    assert.equal(pool.stats.spawned, 1);
    const results = await Promise.all(Array.from({ length: 3 }, () => pool.execute("async () => 1", {})));
    for (const result of results) assert.match(result.error ?? "", /CONTROLLED_STARTUP_FAILURE/);
    await until(() => pool.stats.alive === 0);
    assert.equal(pool.stats.spawned, 4, "one startup attempt per demand, no autonomous retry chain");
    await sleep(120);
    assert.equal(pool.stats.spawned, 4);
  } finally { await pool.close(); }
});

test("every close caller waits for previously recycled worker termination", async (t) => {
  const terminate = Worker.prototype.terminate;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Worker.prototype, "terminate", function (this: Worker) {
    return terminate.call(this).then(async (code) => { await gate; return code; });
  });
  const pool = new PooledWorkerExecutor({ size: 1, maxUses: 1, prewarm: false, idleMs: 0 });
  try {
    assert.equal((await pool.execute("async () => 42", {})).result, 42);
    assert.equal(pool.stats.alive, 0);
    let firstClosed = false, secondClosed = false;
    const first = pool.close().then(() => { firstClosed = true; });
    const second = pool.close().then(() => { secondClosed = true; });
    await sleep(20);
    assert.equal(firstClosed, false);
    assert.equal(secondClosed, false);
    release();
    await Promise.all([first, second]);
    assert.equal(firstClosed && secondClosed, true);
  } finally { release(); await pool.close(); }
});
