import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    assert.match((await pool.execute("async () => { throw new Error('trigger_recycle'); }", {})).error ?? "", /trigger_recycle/);
    assert.equal(pool.stats.alive, 0);
    let firstClosed = false, secondClosed = false;
    const closing = pool.close();
    assert.equal(pool.close(), closing);
    const first = closing.then(() => { firstClosed = true; });
    const second = pool.close().then(() => { secondClosed = true; });
    await sleep(20);
    assert.equal(firstClosed, false);
    assert.equal(secondClosed, false);
    release();
    await Promise.all([first, second]);
    assert.equal(firstClosed && secondClosed, true);
  } finally { release(); await pool.close(); }
});

test("clean maxUses retirement exits without forcing either worker to terminate", async (t) => {
  const terminate = t.mock.method(Worker.prototype, "terminate");
  const postMessage = Worker.prototype.postMessage;
  const exitCodes: number[] = [];
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker, message: { type: string }) {
    if (message.type === "shutdown") this.once("exit", (code) => exitCodes.push(code));
    postMessage.call(this, message);
  });
  const pool = new PooledWorkerExecutor({ size: 1, maxUses: 1, prewarm: false, idleMs: 0 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    assert.equal((await pool.execute("async () => 2", {})).result, 2);
  } finally { await pool.close(); }
  assert.equal(terminate.mock.callCount(), 0);
  assert.deepEqual(exitCodes, [0, 0]);
  assert.equal(pool.stats.spawned, 2);
  assert.equal(pool.stats.alive, 0);
});

test("a terminating worker holds capacity for prewarm and queued jobs", async (t) => {
  const terminate = Worker.prototype.terminate;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Worker.prototype, "terminate", function (this: Worker) {
    return gate.then(() => terminate.call(this));
  });
  const pool = new PooledWorkerExecutor({ size: 1, prewarm: true, idleMs: 0 });
  try {
    assert.match((await pool.execute("async () => { throw new Error('hold_capacity'); }", {})).error ?? "", /hold_capacity/);
    assert.equal(pool.stats.spawned, 1, "prewarm cannot replace a terminating worker yet");
    const next = pool.execute("async () => 42", {});
    assert.equal(pool.stats.queued, 1);
    assert.equal(pool.stats.spawned, 1, "acquire cannot replace a terminating worker yet");
    release();
    await until(() => pool.stats.spawned === 2 && pool.stats.alive === 1);
    assert.equal((await next).result, 42);
    assert.equal((await pool.execute("async () => 43", {})).result, 43);
  } finally { release(); await pool.close(); }
});

test("cooperative close force-terminates a worker that does not receive shutdown", async (t) => {
  const postMessage = Worker.prototype.postMessage;
  const terminate = t.mock.method(Worker.prototype, "terminate");
  const send = t.mock.method(Worker.prototype, "postMessage", function (this: Worker, message: { type: string }) {
    if (message.type !== "shutdown") postMessage.call(this, message);
  });
  const pool = new PooledWorkerExecutor({ size: 1, killGraceMs: 20, idleMs: 0 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
    const closing = pool.close();
    assert.equal(terminate.mock.callCount(), 0, "force must wait for the grace period");
    await closing;
  } finally { await pool.close(); }
  assert.equal(send.mock.calls.filter(({ arguments: [message] }) => message.type === "shutdown").length, 1);
  assert.equal(terminate.mock.callCount(), 1);
  assert.equal(pool.stats.alive, 0);
  assert.equal(pool.stats.spawned, 1);
});

test("close observes forced termination rejection after a failed shutdown send", async (t) => {
  const postMessage = Worker.prototype.postMessage;
  const terminate = Worker.prototype.terminate;
  const failure = new Error("termination rejected");
  const send = t.mock.method(Worker.prototype, "postMessage", function (this: Worker, message: { type: string }) {
    if (message.type === "shutdown") throw new Error("shutdown send failed");
    postMessage.call(this, message);
  });
  const force = t.mock.method(Worker.prototype, "terminate", async function (this: Worker) {
    await terminate.call(this);
    throw failure;
  });
  const pool = new PooledWorkerExecutor({ size: 1, idleMs: 0 });
  try {
    assert.equal((await pool.execute("async () => 1", {})).result, 1);
  } finally {
    const closing = pool.close();
    assert.equal(pool.close(), closing);
    await assert.rejects(closing, failure);
  }
  assert.equal(send.mock.calls.filter(({ arguments: [message] }) => message.type === "shutdown").length, 1);
  assert.equal(force.mock.callCount(), 1);
  assert.equal(pool.stats.alive, 0);
});

// A subprocess makes worker liveness observable without node:test's own active handles.
for (const action of ["demand", "close", "exit"]) {
  test(`idle retirement preserves subprocess liveness semantics for ${action}`, () => {
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const child = `
      import assert from "node:assert/strict";
      import { Worker } from "node:worker_threads";
      import { PooledWorkerExecutor } from ${JSON.stringify(entry)};
      const action = ${JSON.stringify(action)};
      const terminate = Worker.prototype.terminate;
      let forced = 0;
      Worker.prototype.terminate = function () {
        forced++;
        return terminate.call(this);
      };
      const post = Worker.prototype.postMessage;
      const ready = Promise.withResolvers();
      const observeIdle = setTimeout(() => { throw new Error("Idle shutdown was not requested"); }, 5_000);
      Worker.prototype.postMessage = function (message) {
        if (message.type !== "shutdown") return post.call(this, message);
        clearTimeout(observeIdle);
        Worker.prototype.postMessage = post;
        ready.resolve(); // Drop just the first cooperative shutdown to exercise the grace period.
      };
      const pool = new PooledWorkerExecutor({ size: 1, idleMs: 20, killGraceMs: 100, prewarm: false });
      const initial = await pool.execute("async () => 1", {});
      assert.equal(initial.error, undefined);
      assert.equal(initial.result, 1);
      (async () => {
        await ready.promise;
        if (action === "demand") {
          const next = pool.execute("async () => 2", {});
          assert.equal(pool.stats.queued, 1);
          assert.equal(pool.stats.spawned, 1);
          assert.equal((await next).result, 2);
          await pool.close();
          assert.equal(pool.stats.spawned, 2);
        } else if (action === "close") {
          const closing = pool.close();
          assert.equal(pool.close(), closing);
          await closing;
          assert.equal(pool.stats.spawned, 1);
        }
        assert.equal(forced, action === "exit" ? 0 : 1);
        assert.equal(pool.stats.alive, 0);
        console.log("idle retirement: " + action);
      })().catch((error) => { console.error(error); process.exitCode = 1; });
      if (action === "exit") process.on("exit", () => assert.equal(forced, 0));
    `;
    const result = execFileSync(process.execPath, ["-e", child], {
      encoding: "utf8",
      timeout: 12_000,
    });
    assert.equal(result.trim(), `idle retirement: ${action}`);
  });
}
