/** Implementation tests for PooledWorkerExecutor (contract tests live in pool-contract.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PooledWorkerExecutor } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(200);
    assert.equal(pool.stats.alive, 0);
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
