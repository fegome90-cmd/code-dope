/** Implementation tests for PooledWorkerExecutor (contract tests live in pool-contract.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PooledWorkerExecutor } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForReady(pool: PooledWorkerExecutor) {
  const deadline = Date.now() + 3_000;
  while (pool.stats.warming > 0) {
    assert.ok(Date.now() < deadline, "pool workers did not finish warming");
    await sleep(10);
  }
}

test("pool: warming tracks preloaded workers and close does not replace them", async () => {
  const pool = new PooledWorkerExecutor({ size: 2, idleMs: 0 });
  try {
    assert.equal(pool.stats.alive, 2);
    assert.equal(pool.stats.warming, 2);
    await waitForReady(pool);
    assert.equal(pool.stats.alive, 2);
    assert.equal(pool.stats.warming, 0);
    assert.equal(pool.stats.spawned, 2);
  } finally {
    await pool.close();
  }
  assert.equal(pool.stats.alive, 0);
  assert.equal(pool.stats.warming, 0);
  assert.equal(pool.stats.spawned, 2);
});

test("pool: an error restores prewarmed capacity without another execute", async () => {
  const pool = new PooledWorkerExecutor({ size: 2, idleMs: 0 });
  try {
    await waitForReady(pool);
    const before = pool.stats.spawned;
    assert.match((await pool.execute("async () => { throw new Error('recycle'); }", {})).error ?? "", /recycle/);
    assert.equal(pool.stats.alive, 2);
    assert.equal(pool.stats.spawned, before + 1);
    await waitForReady(pool);
    assert.equal(pool.stats.alive, 2);
    assert.equal(pool.stats.warming, 0);
    assert.equal(pool.stats.spawned, before + 1);
  } finally {
    await pool.close();
  }
});

test("pool: maxUses replaces a prewarmed worker before the next execute", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, maxUses: 2, idleMs: 0 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    assert.equal(pool.stats.spawned, 1);
    assert.equal((await pool.execute("async () => 2", {})).result, 2);
    assert.equal(pool.stats.alive, 1);
    assert.equal(pool.stats.spawned, 2);
    await waitForReady(pool);
    assert.equal(pool.stats.warming, 0);
    assert.equal(pool.stats.spawned, 2);
  } finally {
    await pool.close();
  }
});

test("pool: prewarm false leaves recycling and errors on demand", async () => {
  const pool = new PooledWorkerExecutor({ size: 2, maxUses: 1, prewarm: false, idleMs: 0 });
  try {
    assert.equal(pool.stats.spawned, 0);
    assert.equal(pool.stats.alive, 0);
    assert.equal(pool.stats.warming, 0);
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    assert.equal(pool.stats.alive, 0);
    assert.equal(pool.stats.spawned, 1);
    assert.match((await pool.execute("async () => { throw new Error('on demand'); }", {})).error ?? "", /on demand/);
    await sleep(50);
    assert.equal(pool.stats.alive, 0);
    assert.equal(pool.stats.warming, 0);
    assert.equal(pool.stats.spawned, 2);
    assert.equal((await pool.execute("async () => 3", {})).result, 3);
    assert.equal(pool.stats.spawned, 3);
  } finally {
    await pool.close();
  }
});

test("pool: a queued execution is served after the only worker dies", async () => {
  const pool = new PooledWorkerExecutor({ size: 1, timeoutMs: 300, killGraceMs: 100 });
  try {
    const [a, b] = await Promise.all([pool.execute("async () => { for (;;) {} }", {}), pool.execute("async () => 'next'", {})]);
    assert.match(a.error ?? "", /timed out/);
    assert.equal(b.result, "next");
    assert.equal(pool.stats.queued, 0);
  } finally {
    await pool.close();
  }
});

test("pool: idle workers are reaped after idleMs and respawned on demand", async () => {
  const pool = new PooledWorkerExecutor({ size: 2, idleMs: 50 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    const spawned = pool.stats.spawned;
    await sleep(200);
    assert.equal(pool.stats.alive, 0);
    assert.equal(pool.stats.warming, 0);
    assert.equal(pool.stats.spawned, spawned);
    assert.equal((await pool.execute("async () => 2", {})).result, 2);
    assert.equal(pool.stats.alive, 1);
  } finally {
    await pool.close();
  }
});

test("pool: options are validated and connectors are rejected", async () => {
  assert.throws(() => new PooledWorkerExecutor({ size: 0 }), /size/);
  assert.throws(() => new PooledWorkerExecutor({ maxUses: 1.5 }), /maxUses/);
  const pool = new PooledWorkerExecutor({ size: 1, prewarm: false });
  try {
    const r = await pool.execute("async () => 1", {}, { connectors: [{ name: "x" }] } as never);
    assert.match(r.error ?? "", /connector/);
    assert.equal(pool.stats.spawned, 0);
  } finally {
    await pool.close();
  }
});

test("pool: tool errors reach the guest without recycling when the guest handles them", async () => {
  const pool = new PooledWorkerExecutor({ size: 1 });
  try {
    const fns = { boom: async () => { throw new Error("nope"); } };
    const r = await pool.execute("async () => codemode.boom().catch((e) => e.message)", fns);
    assert.equal(r.result, "nope");
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    assert.equal(pool.stats.spawned, 1);
  } finally {
    await pool.close();
  }
});

test("pool: an unclosed pool does not keep the process alive and stack overflows stay off stderr", () => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [new URL("./fixtures/pool-unclosed.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "err 1");
  assert.doesNotMatch(r.stderr, /Aborted|Assertion/);
  assert.ok(Date.now() - t < 10_000);
});
