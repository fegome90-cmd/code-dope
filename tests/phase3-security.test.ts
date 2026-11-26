import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  QuickJSExecutor,
  WorkerExecutor,
  PooledWorkerExecutor,
  withPolicy,
  createAuditLog,
} from "../src/index.ts";
import {
  createCodeModeMcpServer,
  createSearchExecuteMcpServer,
} from "../src/mcp.ts";

// Written blind from the Phase 3 contract. This file is the first concatenable
// part of tests/phase3-security.test.ts. M2 contains no imports.

const phase3ExecutorKinds = ["inline", "worker", "pool"] as const;
type Phase3ExecutorKind = (typeof phase3ExecutorKinds)[number];
type Phase3Executor = ReturnType<typeof withPolicy>;
type Phase3Policy = Parameters<typeof withPolicy>[1];
type Phase3Fns = Record<string, (args: any) => any>;

function phase3Deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function phase3Executor(kind: Phase3ExecutorKind, timeoutMs = 1_500): Phase3Executor {
  switch (kind) {
    case "inline": return new QuickJSExecutor({ timeoutMs });
    case "worker": return new WorkerExecutor({ timeoutMs, killGraceMs: 20 });
    case "pool": return new PooledWorkerExecutor({
      size: 1,
      timeoutMs,
      killGraceMs: 20,
      idleMs: 50,
    });
  }
}

// The pool owns persistent workers; the other public executors may finish
// without an explicit cleanup method. Only the documented close API is used.
async function phase3Dispose(executor: Phase3Executor) {
  const candidate = executor as Phase3Executor & { close?: () => unknown };
  if (candidate.close) await candidate.close();
}

async function phase3Eventually(predicate: () => boolean, message: string, ms = 1_800) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

function phase3AssertSuccess(value: { result?: unknown; error?: unknown }, expected: unknown) {
  assert.ifError(value.error);
  assert.deepEqual(value.result, expected);
}

for (const kind of phase3ExecutorKinds) {
  test(`M1 ${kind}: timed-out approval cannot invoke a write after execute returns`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const approval = phase3Deferred<boolean>();
      const log = createAuditLog();
      let requested = 0;
      let writes = 0;
      let signal: AbortSignal | undefined;
      const executor = withPolicy(inner, {
        write: ["write_value"],
        approve: async (request) => {
          requested += 1;
          signal = request.signal;
          return approval.promise;
        },
        audit: log.sink,
      });
      t.after(async () => {
        approval.resolve(false);
        await phase3Dispose(inner);
      });

      const pending = executor.execute(
        "async () => { return await codemode.write_value({ value: 1 }); }",
        { write_value: async () => { writes += 1; return "written"; } },
      );
      await phase3Eventually(() => requested === 1, "approval must start before the timeout");
      assert.equal(writes, 0, "approval must precede the write");
      assert.ok(signal, "approval requests must expose their execution AbortSignal");
      assert.equal(signal.aborted, false, "execution must be open while approval is pending");

      const outcome = await pending;
      assert.match(outcome.error ?? "", /Execution timed out/);
      assert.equal(writes, 0, "the write must not run before execute returns");
      assert.equal(signal.aborted, true, "timeout must abort the approval signal");

      approval.resolve(true);
      await phase3Eventually(
        () => log.records.some((record) => record.decision === "denied"
          && record.reason?.includes("execution already finished")),
        "late approval must produce a denied audit record explaining execution closure",
      );
      assert.equal(writes, 0, "late approval must never invoke the underlying write");
      assert.equal(
        log.records.filter((record) => record.decision === "allowed"
          && record.outcome === "done").length,
        0,
        "a blocked late write must not be audited as allowed/done",
      );
    });

  test(`M1 ${kind}: an unawaited write awaiting approval cannot outlive a successful execution`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const approval = phase3Deferred<boolean>();
      const log = createAuditLog();
      let requested = 0;
      let writes = 0;
      let signal: AbortSignal | undefined;
      const executor = withPolicy(inner, {
        write: ["write_value"],
        approve: async (request) => {
          requested += 1;
          signal = request.signal;
          return approval.promise;
        },
        audit: log.sink,
      });
      t.after(async () => {
        approval.resolve(false);
        await phase3Dispose(inner);
      });

      const outcome = await executor.execute(
        "async () => { void codemode.write_value({ value: 2 }).catch(() => undefined); return 'finished'; }",
        { write_value: async () => { writes += 1; return "written"; } },
      );
      phase3AssertSuccess(outcome, "finished");
      assert.equal(requested, 1, "the unawaited call must actually reach approval");
      assert.equal(writes, 0);
      assert.ok(signal, "the pending approval must have an AbortSignal");
      assert.equal(signal.aborted, true, "successful completion must abort pending approval");

      approval.resolve(true);
      await phase3Eventually(
        () => log.records.some((record) => record.decision === "denied"
          && record.reason?.includes("execution already finished")),
        "unawaited late approval must be denied with the execution-closure reason",
      );
      assert.equal(writes, 0, "a fire-and-forget call must not write after execution ends");
      assert.equal(log.records.filter((record) => record.decision === "allowed"
        && record.outcome === "done").length, 0);
    });

  test(`M1 ${kind}: approval signals abort after an ordinary successful execution`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      let signal: AbortSignal | undefined;
      let abortEvents = 0;
      const executor = withPolicy(inner, {
        write: ["write_value"],
        approve: async (request) => {
          signal = request.signal;
          assert.ok(signal, "ApprovalRequest.signal must be supplied by withPolicy");
          assert.equal(signal.aborted, false);
          signal.addEventListener("abort", () => { abortEvents += 1; });
          return true;
        },
      });
      t.after(() => phase3Dispose(inner));
      const outcome = await executor.execute(
        "async () => codemode.write_value({})",
        { write_value: async () => {
          assert.equal(signal?.aborted, false, "the signal must remain open inside an active tool");
          return "ok";
        } },
      );
      phase3AssertSuccess(outcome, "ok");
      assert.ok(signal);
      assert.equal(signal.aborted, true);
      assert.equal(abortEvents, 1, "one execution must have one abort transition");
    });

  test(`M1 ${kind}: a read already in flight can finish, with afterExecutionEnd audit evidence`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const readGate = phase3Deferred<string>();
      const log = createAuditLog();
      let reads = 0;
      let finishedReads = 0;
      const executor = withPolicy(inner, { read: ["read_value"], audit: log.sink });
      t.after(async () => {
        readGate.resolve("late-value");
        await phase3Dispose(inner);
      });
      const pending = executor.execute(
        "async () => codemode.read_value({})",
        { read_value: async () => {
          reads += 1;
          const value = await readGate.promise;
          finishedReads += 1;
          return value;
        } },
      );
      await phase3Eventually(() => reads === 1, "the read must already be inside its tool");
      const outcome = await pending;
      assert.match(outcome.error ?? "", /Execution timed out/);
      assert.equal(finishedReads, 0);

      readGate.resolve("late-value");
      await phase3Eventually(
        () => log.records.some((record) => record.decision === "allowed"
          && record.outcome === "done"),
        "the already-started read must still produce a completion audit record",
      );
      assert.equal(reads, 1);
      assert.equal(finishedReads, 1, "execution closure must not cancel a tool already in flight");
      const completions = log.records.filter((record) => record.decision === "allowed"
        && record.outcome === "done");
      assert.equal(completions.length, 1);
      assert.equal(completions[0].afterExecutionEnd, true,
        "a tool finishing after execute must be explicitly marked in audit");
    });

  test(`M1 H1 ${kind}: concurrent pending approvals reserve the call budget before approval resolves`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const approval = phase3Deferred<boolean>();
      const log = createAuditLog();
      let approvals = 0;
      let writes = 0;
      const executor = withPolicy(inner, {
        write: ["write_value"],
        maxCalls: 1,
        approve: async () => { approvals += 1; return approval.promise; },
        audit: log.sink,
      });
      t.after(async () => {
        approval.resolve(false);
        await phase3Dispose(inner);
      });
      const pending = executor.execute(
        "async () => Promise.allSettled([codemode.write_value({ n: 1 }), codemode.write_value({ n: 2 })])",
        { write_value: async () => { writes += 1; return "written"; } },
      );
      await phase3Eventually(
        () => approvals > 1 || log.records.some((record) => record.decision === "denied"),
        "the second concurrent call must be denied while the first approval is pending",
      );
      assert.equal(approvals, 1, "only the reserved call may reach approval");
      assert.equal(writes, 0);
      assert.ok(log.records.some((record) => record.decision === "denied"
        && /maxCalls|max(?:imum)?.*call|call.*(?:limit|budget)|budget/i.test(record.reason ?? "")),
      "the rejected concurrent call must identify the exhausted call budget");

      approval.resolve(true);
      const outcome = await pending;
      assert.ifError(outcome.error);
      const settled = outcome.result as Array<{ status: string }>;
      assert.equal(settled.length, 2);
      assert.deepEqual(settled.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(writes, 1, "one approval slot must never produce two tool invocations");
    });
}
