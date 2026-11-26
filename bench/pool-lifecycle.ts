/** Bounded synthetic lifecycle trace; not a soak or evidence of native-crash resolution. */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { PooledWorkerExecutor } from "../src/executor/pool-executor.ts";

const started = performance.now();
const events: Array<Record<string, unknown>> = [];
const summaries: Array<Record<string, unknown>> = [];
const ids = new WeakMap<Worker, number>();
let nextId = 0;
let scenario = "setup";
const record = (event: string, detail: Record<string, unknown> = {}) => {
  events.push({ seq: events.length + 1, ms: Math.round((performance.now() - started) * 1000) / 1000, scenario, event, ...detail });
};
const workerId = (worker: Worker) => {
  let id = ids.get(worker);
  if (id === undefined) { id = ++nextId; ids.set(worker, id); }
  return id;
};
const originalEmit = Worker.prototype.emit;
const originalTerminate = Worker.prototype.terminate;
Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
  const worker = workerId(this);
  if (event === "online" || event === "exit") record(`worker:${event}`, { worker, ...(event === "exit" ? { code: args[0] } : {}) });
  if (event === "error") record("worker:error", { worker, error: String(args[0]) });
  if (event === "message") {
    const message = args[0] as { type?: string; job?: number; result?: { error?: string }; error?: string };
    if (["ready", "done", "failed"].includes(message.type ?? "")) {
      record(`worker:${message.type}`, { worker, job: message.job, error: message.error ?? message.result?.error });
    }
  }
  return originalEmit.call(this, event, ...args);
};
Worker.prototype.terminate = function (this: Worker) {
  const worker = workerId(this);
  record("terminate:start", { worker });
  return originalTerminate.call(this).then((code) => { record("terminate:end", { worker, code }); return code; });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) { assert.ok(Date.now() < deadline, "bounded lifecycle condition did not settle"); await sleep(5); }
}
async function close(pool: PooledWorkerExecutor) {
  record("close:start", { stats: pool.stats });
  await pool.close();
  record("close:end", { stats: pool.stats });
  assert.equal(pool.stats.alive, 0);
  summaries.push({ scenario, status: "PASS", stats: pool.stats });
}
async function run(pool: PooledWorkerExecutor, code: string, fns = {}) {
  record("execution:start", { stats: pool.stats });
  const result = await pool.execute(code, fns);
  record("execution:end", { error: result.error, stats: pool.stats });
  return result;
}

try {
  scenario = "successful-recycling";
  let pool = new PooledWorkerExecutor({ size: 1, maxUses: 2, idleMs: 0 });
  try {
    await until(() => pool.stats.warming === 0);
    assert.equal((await run(pool, "async () => 1")).result, 1);
    assert.equal((await run(pool, "async () => 2")).result, 2);
    await until(() => pool.stats.warming === 0);
    assert.equal((await run(pool, "async () => 3")).result, 3);
  } finally { await close(pool); }

  scenario = "ordinary-guest-error-and-recovery";
  pool = new PooledWorkerExecutor({ size: 1, idleMs: 0 });
  try {
    assert.match((await run(pool, 'async () => { throw new Error("CONTROLLED_GUEST_ERROR"); }')).error ?? "", /CONTROLLED_GUEST_ERROR/);
    assert.equal((await run(pool, "async () => 42")).result, 42);
  } finally { await close(pool); }

  scenario = "synthetic-tool-timeout";
  pool = new PooledWorkerExecutor({ size: 1, idleMs: 0, timeoutMs: 100, killGraceMs: 100 });
  try {
    await until(() => pool.stats.warming === 0);
    const result = await run(pool, "async () => codemode.pending({})", { pending: async () => new Promise(() => {}) });
    assert.match(result.error ?? "", /timed out/);
  } finally { await close(pool); }

  scenario = "startup-failure-with-bounded-demand";
  pool = new PooledWorkerExecutor({ size: 1, idleMs: 0, preludes: ['throw new Error("CONTROLLED_STARTUP_FAILURE")'] });
  try {
    await until(() => pool.stats.alive === 0);
    await sleep(100);
    assert.equal(pool.stats.spawned, 1);
    assert.match((await run(pool, "async () => 1")).error ?? "", /CONTROLLED_STARTUP_FAILURE/);
    await sleep(100);
    assert.equal(pool.stats.spawned, 2);
  } finally { await close(pool); }

  scenario = "reserved-slot-close";
  pool = new PooledWorkerExecutor({ size: 1, idleMs: 0 });
  try {
    assert.equal((await run(pool, "async () => 1")).result, 1);
    const pending = run(pool, "async () => 2");
    const closing = close(pool);
    assert.match((await pending).error ?? "", /closed/);
    await closing;
  } finally { await pool.close(); }

  const terminating = events.filter((event) => event.event === "terminate:start");
  assert.equal(events.filter((event) => event.event === "terminate:end").length, terminating.length);
  assert.equal(events.filter((event) => event.event === "worker:exit").length, nextId);
  process.stdout.write(JSON.stringify({
    recordedAt: new Date().toISOString(), node: process.version, status: "PASS",
    scope: "Five bounded synthetic functional scenarios with parent-side worker lifecycle events; no native stack trace, real services, or sustained load.",
    nativeCrashCause: "NOT_VERIFIED", nativeStability: "NOT_VERIFIED", defaultIsolation: "worker",
    summaries, workersObserved: nextId, events,
  }, null, 2) + "\n");
} finally {
  Worker.prototype.emit = originalEmit;
  Worker.prototype.terminate = originalTerminate;
}
