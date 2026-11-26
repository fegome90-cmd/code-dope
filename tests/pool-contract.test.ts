/** Contract tests for PooledWorkerExecutor (black-box; behavior only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PooledWorkerExecutor, WorkerExecutor, createDefaultExecutor, createCodeRunner, withPolicy } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fns = {
  add: async (a: unknown) => { const { x, y } = a as { x: number; y: number }; return x + y; },
  echo: async (a: unknown) => a,
  slow: async (a: unknown) => { await sleep(60); return (a as { n: number }).n; },
};

test("pool: basic execute with fns record, provider array, logs, and never-rejecting errors", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    const r = await pool.execute("async () => { console.log('hi', 1); return codemode.add({ x: 2, y: 3 }); }", fns);
    assert.equal(r.error, undefined);
    assert.equal(r.result, 5);
    assert.deepEqual(r.logs, ["hi 1"]);
    const p = await pool.execute("async () => svc.add({ x: 1, y: 1 })", [{ name: "svc", fns }]);
    assert.equal(p.result, 2);
    const bad = await pool.execute("async () => { throw new Error('boom'); }", fns);
    assert.match(bad.error ?? "", /boom/);
  } finally { await pool.close(); }
});

test("pool: global state does not leak between runs, even on a reused worker", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    assert.equal((await pool.execute("async () => { globalThis.x = 1; return globalThis.x; }", {})).result, 1);
    assert.equal((await pool.execute("async () => typeof globalThis.x", {})).result, "undefined");
    assert.equal(pool.stats.spawned, 1);
  } finally { await pool.close(); }
});

test("pool: guest has no Node globals; tools run in the parent thread", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  process.env.POOL_TEST_SECRET = "s3cr3t";
  try {
    const r = await pool.execute("async () => [typeof process, typeof require, await codemode.env()]", { env: async () => process.env.POOL_TEST_SECRET });
    assert.deepEqual(r.result, ["undefined", "undefined", "s3cr3t"]);
  } finally { delete process.env.POOL_TEST_SECRET; await pool.close(); }
});

test("pool: workers are reused across successful runs (size 1, 5 runs => spawned 1)", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await pool.execute(`async () => ${i}`, {})).result, i);
    assert.equal(pool.stats.spawned, 1);
  } finally { await pool.close(); }
});

test("pool: a failing execution (even a plain throw) replaces the worker", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    const before = pool.stats.spawned;
    assert.ok((await pool.execute("async () => { throw new Error('x'); }", {})).error);
    assert.equal((await pool.execute("async () => 2", {})).result, 2);
    assert.equal(pool.stats.spawned, before + 1);
  } finally { await pool.close(); }
});

test("pool: maxUses recycles workers (maxUses 2, 5 runs => spawned 3)", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, maxUses: 2, prewarm: false, timeoutMs: 2000 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await pool.execute(`async () => ${i}`, {})).result, i);
    assert.equal(pool.stats.spawned, 3);
  } finally { await pool.close(); }
});

test("pool: timeout kills the worker, and the pool keeps serving", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 500 });
  try {
    assert.match((await pool.execute("async () => { for (;;) {} }", {})).error ?? "", /timed out/);
    assert.equal((await pool.execute("async () => codemode.add({ x: 20, y: 22 })", fns)).result, 42);
    const hang = await pool.execute("async () => codemode.never()", { never: () => new Promise(() => {}) });
    assert.match(hang.error ?? "", /timed out/);
    assert.equal((await pool.execute("async () => 'ok'", {})).result, "ok");
  } finally { await pool.close(); }
});

test("pool: CPU-bound guest does not block the host event loop", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 600 });
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  try {
    const r = await pool.execute("async () => { for (;;) {} }", {});
    assert.match(r.error ?? "", /timed out/);
    assert.ok(ticks >= 10, `only ${ticks} ticks`);
  } finally { clearInterval(iv); await pool.close(); }
});

test("pool: repeated stack overflows do not poison later executions", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    for (let i = 0; i < 4; i++) assert.ok((await pool.execute("async () => { function f() { f(); } f(); }", {})).error);
    assert.equal((await pool.execute("async () => 7 * 6", {})).result, 42);
  } finally { await pool.close(); }
});

test("pool: concurrency is capped at size, extras queue and all complete correctly", async () => {
  const pool = new PooledWorkerExecutor({ size: 2, timeoutMs: 3000 });
  try {
    let maxAlive = 0;
    const iv = setInterval(() => { maxAlive = Math.max(maxAlive, pool.stats.alive); }, 5);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      assert.ok(pool.stats.alive <= 2);
      return pool.execute(`async () => codemode.slow({ n: ${i} })`, fns);
    }));
    clearInterval(iv);
    assert.deepEqual(results.map((r) => r.result), [0, 1, 2, 3, 4, 5]);
    assert.ok(results.every((r) => r.error === undefined));
    assert.ok(maxAlive <= 2, `alive reached ${maxAlive}`);
    const s = pool.stats;
    assert.equal(s.queued, 0);
    assert.equal(s.busy, 0);
  } finally { await pool.close(); }
});

test("pool: a late tool reply from an abandoned call does not affect the next execution", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    const lateFns = { late: async () => { await sleep(150); return "LATE"; }, add: fns.add };
    const first = await pool.execute("async () => { codemode.late(); return 'first'; }", lateFns);
    assert.equal(first.result, "first");
    const second = await pool.execute("async () => { const r = await codemode.add({ x: 1, y: 2 }); await codemode.add({ x: 1, y: 1 }); return r; }", lateFns);
    assert.equal(second.result, 3);
    await sleep(200);
    assert.equal((await pool.execute("async () => codemode.add({ x: 5, y: 5 })", lateFns)).result, 10);
  } finally { await pool.close(); }
});

test("pool: close() is idempotent, later executes error with /closed/, in-flight executions resolve with an error", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 5000 });
  const inflight = pool.execute("async () => codemode.hang()", { hang: () => new Promise(() => {}) });
  await sleep(100);
  const c1 = pool.close();
  assert.ok(c1 instanceof Promise);
  await c1;
  await pool.close();
  const r = await inflight;
  assert.ok(r.error);
  assert.match((await pool.execute("async () => 1", {})).error ?? "", /closed/);
});

test("pool: withPolicy still fails closed (unclassified and unapproved write)", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 2000 });
  try {
    const g = withPolicy(pool, { read: ["add"], write: ["w"] });
    const wfns = { add: fns.add, w: async () => "x", other: async () => "y" };
    assert.equal((await g.execute("async () => codemode.add({ x: 1, y: 2 })", wfns)).result, 3);
    assert.match((await g.execute("async () => codemode.other({})", wfns)).error ?? "", /not classified/);
    assert.match((await g.execute("async () => codemode.w({})", wfns)).error ?? "", /Denied/);
  } finally { await pool.close(); }
});

test("pool: createDefaultExecutor('pool') preloads helpers; default stays WorkerExecutor", async () => {
  const ex = createDefaultExecutor("pool", { timeoutMs: 2000 });
  try {
    assert.ok(ex instanceof PooledWorkerExecutor);
    assert.equal((await ex.execute("async () => typeof helpers.parallel", {})).result, "function");
  } finally { await (ex as PooledWorkerExecutor).close(); }
  assert.ok(createDefaultExecutor() instanceof WorkerExecutor);
});

test("pool: createCodeRunner with isolation 'pool' runs tools under policy", async () => {
  const runner = createCodeRunner({
    tools: { t: { get: async () => "from-parent", w: async () => "x" } },
    policy: { read: ["get"], write: ["w"] },
    executor: { timeoutMs: 2000 },
    isolation: "pool",
  });
  const r = await runner.run("async () => [await t.get(), typeof process, await t.w().catch((e) => e.message)]");
  try {
    assert.equal(r.error, undefined);
    const [a, b, c] = r.result as string[];
    assert.equal(a, "from-parent");
    assert.equal(b, "undefined");
    assert.match(c, /Denied/);
  } finally {
    // The runner does not expose its executor; the pool must not keep the process alive past idleMs/unref.
  }
});
