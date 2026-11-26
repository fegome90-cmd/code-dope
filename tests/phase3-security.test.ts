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
// Concatenate after phase3-security-m1.test.ts; imports and lifecycle helpers
// intentionally live in M1 only. These assertions were written without reading
// implementation or existing tests.

for (const kind of phase3ExecutorKinds) {
  for (const classification of ["read", "write"] as const) {
    for (const allowed of ["delete_user", "delete-user"] as const) {
      const forbidden = allowed === "delete_user" ? "delete-user" : "delete_user";
      test(`M2 ${kind}: ${classification} names collision member ${allowed} exactly`,
        { timeout: 5_000 }, async (t) => {
          const inner = phase3Executor(kind);
          const invoked: string[] = [];
          let approvals = 0;
          const executor = withPolicy(inner, {
            [classification]: [allowed],
            approve: async () => { approvals += 1; return true; },
          });
          t.after(() => phase3Dispose(inner));
          const fns: Phase3Fns = {
            delete_user: async () => { invoked.push("delete_user"); return "underscore"; },
            "delete-user": async () => { invoked.push("delete-user"); return "hyphen"; },
          };

          const allowedResult = await executor.execute(
            `async () => codemode[${JSON.stringify(allowed)}]({ id: 'one' })`, fns,
          );
          phase3AssertSuccess(allowedResult, allowed === "delete_user" ? "underscore" : "hyphen");
          const deniedResult = await executor.execute(
            `async () => codemode[${JSON.stringify(forbidden)}]({ id: 'two' })`, fns,
          );
          assert.equal(typeof deniedResult.error, "string");
          assert.match(String(deniedResult.error), /not classified/i);
          assert.ok(String(deniedResult.error).includes(
            `"${forbidden}" collides with "${allowed}" after sanitization; name it exactly in the policy`,
          ), "unclassified collision denial must name both tools and the exact-policy remedy");
          assert.deepEqual(invoked, [allowed], "a policy entry must authorize only its exact collision member");
          assert.equal(approvals, classification === "write" ? 1 : 0,
            "an unclassified colliding tool must never reach approval");
        });
    }
  }

  test(`M2 ${kind}: deny remains sanitized and blocks both collision members`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      let invoked = 0;
      const executor = withPolicy(inner, {
        read: ["delete_user", "delete-user"],
        deny: ["delete-user"],
      });
      t.after(() => phase3Dispose(inner));
      const fns: Phase3Fns = {
        delete_user: async () => { invoked += 1; return "underscore"; },
        "delete-user": async () => { invoked += 1; return "hyphen"; },
      };
      for (const name of ["delete_user", "delete-user"]) {
        const outcome = await executor.execute(
          `async () => codemode[${JSON.stringify(name)}]({})`, fns,
        );
        assert.equal(typeof outcome.error, "string");
        assert.match(String(outcome.error), /denied/i);
      }
      assert.equal(invoked, 0, "sanitized deny must cover every variant in the collision");
    });

  test(`M2 ${kind}: sanitized deny keeps its behavior when no collision exists`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      let invoked = 0;
      const executor = withPolicy(inner, {
        read: ["delete_user"],
        deny: ["delete-user"],
      });
      t.after(() => phase3Dispose(inner));
      const outcome = await executor.execute(
        "async () => codemode.delete_user({})",
        { delete_user: async () => { invoked += 1; return "deleted"; } },
      );
      assert.equal(typeof outcome.error, "string");
      assert.match(String(outcome.error), /denied/i);
      assert.equal(invoked, 0);
    });

  test(`M2 ${kind}: validators match the exact member of a collision`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const invoked: string[] = [];
      let validations = 0;
      const executor = withPolicy(inner, {
        read: ["delete_user", "delete-user"],
        validate: {
          delete_user: () => { validations += 1; return "underscore blocked by validator"; },
        },
      });
      t.after(() => phase3Dispose(inner));
      const fns: Phase3Fns = {
        delete_user: async () => { invoked.push("delete_user"); return "underscore"; },
        "delete-user": async () => { invoked.push("delete-user"); return "hyphen"; },
      };
      phase3AssertSuccess(await executor.execute(
        "async () => codemode['delete-user']({})", fns,
      ), "hyphen");
      assert.equal(validations, 0, "the other collision member must not inherit a validator");
      const blocked = await executor.execute("async () => codemode.delete_user({})", fns);
      assert.match(String(blocked.error), /underscore blocked by validator/);
      assert.equal(validations, 1);
      assert.deepEqual(invoked, ["delete-user"]);
    });
}

for (const kind of phase3ExecutorKinds) {
  test(`M2 ${kind}: provider-qualified allowlists name a collision member exactly`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      const invoked: string[] = [];
      const executor = withPolicy(inner, { read: ["catalog.delete_user"] });
      t.after(() => phase3Dispose(inner));
      const providers = [{ name: "catalog", fns: {
        delete_user: async () => { invoked.push("delete_user"); return "underscore"; },
        "delete-user": async () => { invoked.push("delete-user"); return "hyphen"; },
      } }];
      phase3AssertSuccess(await executor.execute(
        "async () => catalog.delete_user({})", providers,
      ), "underscore");
      const forbidden = await executor.execute(
        "async () => catalog['delete-user']({})", providers,
      );
      assert.match(String(forbidden.error), /not classified/i);
      assert.match(String(forbidden.error), /collides.*after sanitization/i);
      assert.deepEqual(invoked, ["delete_user"]);
    });

  test(`M2 ${kind}: an unambiguous sanitized allowlist retains compatibility`,
    { timeout: 5_000 }, async (t) => {
      const inner = phase3Executor(kind);
      let invoked = 0;
      const executor = withPolicy(inner, { read: ["delete-user"] });
      t.after(() => phase3Dispose(inner));
      phase3AssertSuccess(await executor.execute("async () => codemode.delete_user({})", {
        delete_user: async () => { invoked += 1; return "underscore"; },
      }), "underscore");
      assert.equal(invoked, 1);
    });
}

// Public-protocol scaffolding only. Text is read from actual MCP responses;
// names, descriptions and declarations are never reconstructed from the policy.
type Phase3McpKind = "code-mode" | "search-execute";

function phase3McpText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(phase3McpText).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value).map(phase3McpText).join("\n");
  }
  return "";
}

// Recognize ordinary TS callable declarations, preserving duplicate matches.
// Hyphenated declarations must use a quoted or computed property name.
function phase3DeclarationNames(text: string): string[] {
  const names: string[] = [];
  for (const name of ["delete_user", "delete-user"]) {
    const quoted = `["']${name}["']`;
    const spelling = name === "delete_user"
      ? `(?:delete_user|${quoted}|\\[\\s*${quoted}\\s*\\])`
      : `(?:${quoted}|\\[\\s*${quoted}\\s*\\])`;
    const callable = new RegExp(
      `(?<![\\w$.-])${spelling}\\s*(?:\\([^)]*\\)\\s*:|:\\s*\\([^)]*\\)\\s*=>)`,
      "g",
    );
    for (const _match of text.matchAll(callable)) names.push(name);
  }
  return names;
}

async function phase3McpFixture(
  kind: Phase3McpKind,
  isolation: Phase3ExecutorKind,
  policy: Phase3Policy,
) {
  const invoked: string[] = [];
  const upstream = new McpServer({ name: "phase3-collision-fixture", version: "1.0.0" });
  for (const name of ["delete_user", "delete-user"]) {
    upstream.registerTool(name, {
      description: `Delete fixture tool with exact name ${name}.`,
      inputSchema: {},
    }, async () => {
      invoked.push(name);
      return { content: [{ type: "text" as const, text: name }] };
    });
  }
  const inner = phase3Executor(isolation);
  const client = new Client({ name: "phase3-collision-client", version: "1.0.0" });
  let server: McpServer | undefined;
  const close = async () => {
    await Promise.allSettled([
      client.close(),
      ...(server ? [server.close()] : []),
      upstream.close(),
      phase3Dispose(inner),
    ]);
  };
  try {
    const factory = kind === "code-mode" ? createCodeModeMcpServer : createSearchExecuteMcpServer;
    server = await factory({ upstream, policy, executor: inner });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const descriptions = listed.tools.map((tool) => tool.description ?? "").join("\n");
    let declarationText: string;
    let advertisedText = descriptions;
    if (kind === "code-mode") {
      const codeTools = listed.tools.filter((tool) => tool.name === "code");
      assert.equal(codeTools.length, 1, "the simple MCP surface must expose its code tool");
      declarationText = codeTools[0].description ?? "";
    } else {
      const discovery = await client.callTool({
        name: "search_tools", arguments: { query: "delete", limit: 20 },
      });
      assert.notEqual(discovery.isError, true, "discovery must complete successfully");
      declarationText = phase3McpText(discovery);
      advertisedText += `\n${declarationText}`;
    }
    return {
      invoked,
      advertisedText,
      declarationNames: phase3DeclarationNames(declarationText),
      close,
      execute: (code: string) => client.callTool({
        name: kind === "code-mode" ? "code" : "execute", arguments: { code },
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const kind of ["code-mode", "search-execute"] as const) {
  for (const isolation of phase3ExecutorKinds) {
    test(`M2 MCP ${kind} ${isolation}: discovery hides the unclassified collision member everywhere`,
      { timeout: 5_000 }, async (t) => {
        const fixture = await phase3McpFixture(kind, isolation, { read: ["delete_user"] });
        t.after(fixture.close);
        assert.deepEqual(fixture.declarationNames, ["delete_user"],
          "the permitted tool must have exactly one callable declaration");
        assert.ok(fixture.advertisedText.includes("delete_user"));
        assert.ok(!fixture.advertisedText.includes("delete-user"),
          "the forbidden name must not leak into types or published descriptions");
        const result = await fixture.execute("async () => codemode.delete_user({})");
        assert.notEqual(result.isError, true);
        assert.deepEqual(fixture.invoked, ["delete_user"]);
      });

    test(`M2 MCP ${kind} ${isolation}: both allowed members have distinct exact declarations and work`,
      { timeout: 5_000 }, async (t) => {
        const fixture = await phase3McpFixture(kind, isolation, {
          read: ["delete_user", "delete-user"],
        });
        t.after(fixture.close);
        assert.deepEqual([...fixture.declarationNames].sort(), ["delete-user", "delete_user"],
          "each real name must have one callable declaration; duplicate aliases are forbidden");
        assert.ok(fixture.advertisedText.includes("delete_user"));
        assert.ok(fixture.advertisedText.includes("delete-user"));
        const result = await fixture.execute(
          "async () => { await codemode.delete_user({}); return await codemode['delete-user']({}); }",
        );
        assert.notEqual(result.isError, true);
        assert.deepEqual(fixture.invoked, ["delete_user", "delete-user"],
          "both exact guest names must reach their own upstream tools");
      });

    test(`M2 MCP ${kind} ${isolation}: sanitized deny hides both collision members`,
      { timeout: 5_000 }, async (t) => {
        const fixture = await phase3McpFixture(kind, isolation, {
          read: ["delete_user", "delete-user"], deny: ["delete-user"],
        });
        t.after(fixture.close);
        assert.deepEqual(fixture.declarationNames, []);
        assert.ok(!fixture.advertisedText.includes("delete_user"));
        assert.ok(!fixture.advertisedText.includes("delete-user"));
        assert.deepEqual(fixture.invoked, []);
      });
  }
}
