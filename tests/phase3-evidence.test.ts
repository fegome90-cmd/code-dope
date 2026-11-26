import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { QuickJSExecutor } from "../src/index.ts";
import { createSearchExecuteMcpServer } from "../src/mcp.ts";

// M5 evidence tests. The memory test intentionally permits either resource limit
// to win; this file does not claim deterministic ordering between GC and timeout.

test("M5 inline CPU execution blocks host interval ticks after the guest starts its loop",
  { timeout: 5_000 }, async (t) => {
    const timeoutMs = 400;
    const tickMs = 5;
    const executor = new QuickJSExecutor({ timeoutMs });
    let interval: ReturnType<typeof setInterval> | undefined;
    let loopStartedAt: number | undefined;
    let marks = 0;
    let ticks = 0;
    t.after(() => { if (interval) clearInterval(interval); });

    const result = await executor.execute(
      "async () => { await codemode.mark_loop_start({}); for (;;) {} }",
      { mark_loop_start: async () => {
        marks += 1;
        // Module/context initialization happened before this host callback.
        // Start the measurement here, immediately before the guest CPU loop.
        if (interval) clearInterval(interval);
        ticks = 0;
        loopStartedAt = performance.now();
        interval = setInterval(() => { ticks += 1; }, tickMs);
        return null;
      } },
    );
    const finishedAt = performance.now();
    if (interval) clearInterval(interval);
    const ticksDuringLoop = ticks;

    assert.equal(marks, 1, "the guest must reach the measurement marker exactly once");
    assert.notEqual(loopStartedAt, undefined);
    assert.match(result.error ?? "", /timed out/i);
    const measuredMs = finishedAt - loopStartedAt!;
    assert.ok(measuredMs >= 150,
      `the measured loop must span many ${tickMs}ms tick opportunities; observed ${measuredMs.toFixed(1)}ms`);
    assert.ok(ticksDuringLoop <= 1,
      `inline CPU work must block host timers; observed ${ticksDuringLoop} ticks over ${measuredMs.toFixed(1)}ms`);
    t.diagnostic(`inline loop: ${measuredMs.toFixed(1)}ms, ${ticksDuringLoop} host ticks, ${tickMs}ms interval`);
  });

test("M5 progressive MCP unwrap prefers toolResult over error, structured content and text",
  { timeout: 5_000 }, async (t) => {
    const expected = { source: "toolResult", value: 42, nested: { preserved: true } };
    const upstream = new McpServer({ name: "m5-tool-result-upstream", version: "1.0.0" });
    const client = new Client({ name: "m5-tool-result-client", version: "1.0.0" });
    let server: McpServer | undefined;
    let calls = 0;
    t.after(async () => {
      await Promise.allSettled([
        client.close(),
        ...(server ? [server.close()] : []),
        upstream.close(),
      ]);
    });
    upstream.registerTool("precedence_result", {
      description: "Return deliberately conflicting MCP result representations.",
      inputSchema: {},
    }, async () => {
      calls += 1;
      return {
        toolResult: expected,
        isError: true,
        structuredContent: { source: "structuredContent", value: -1 },
        content: [{ type: "text" as const, text: JSON.stringify({ source: "text", value: -2 }) }],
      };
    });

    server = await createSearchExecuteMcpServer({
      upstream,
      policy: { read: ["precedence_result"] },
      executor: new QuickJSExecutor({ timeoutMs: 1_500 }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "execute", arguments: { code: "async () => codemode.precedence_result({})" },
    });
    assert.equal(calls, 1, "the response must come from the upstream tool");
    assert.notEqual(response.isError, true, "toolResult takes precedence even over upstream isError");
    const content = response.content as Array<{ type: string; text?: string }>;
    const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    assert.deepEqual(JSON.parse(text), expected);
  });

test("M5 a large heap and massive retained allocation ends in memory exhaustion or timeout",
  { timeout: 5_000 }, async (t) => {
    const memoryLimitBytes = 256 * 1024 * 1024;
    const executor = new QuickJSExecutor({ timeoutMs: 300, memoryLimitBytes });
    let allocationStarted = false;
    const result = await executor.execute(
      `async () => {
        await codemode.begin_allocation({});
        const retained = [];
        for (let block = 0; block < 512; block++) {
          retained.push(new Array(1_000_000).fill(block));
        }
        return retained.length;
      }`,
      { begin_allocation: async () => { allocationStarted = true; return null; } },
    );
    assert.equal(allocationStarted, true, "the guest must reach the allocation workload");
    assert.match(result.error ?? "", /out of memory|timed out/i,
      "GC and runtime scheduling may change which resource limit is observed first");
    t.diagnostic(`large-heap allocation: heap=${memoryLimitBytes} bytes; observed error=${result.error}`);
  });

test("M5 the Cloudflare root entry still rejects in Node because of a cloudflare: import",
  { timeout: 5_000 }, async () => {
    // An upstream fix intentionally turns this into a failing evidence check so
    // the compatibility claim and the import strategy can be reviewed together.
    await assert.rejects(import("@cloudflare/codemode"), /cloudflare:/);
  });
