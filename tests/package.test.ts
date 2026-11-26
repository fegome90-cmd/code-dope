import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("M3: packed dependency runs inline, worker and pool, and exposes usable declarations", { timeout: 120_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "code-dope-package-"));
  try {
    const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8", timeout: 30_000 }))[0] as { filename: string; files: Array<{ path: string }> };
    const files = packed.files.map((f) => f.path);
    for (const path of ["dist/index.js", "dist/index.d.ts", "dist/mcp.js", "dist/executor/worker-entry.js", "dist/sandbox/helpers.js"]) assert.ok(files.includes(path), `missing ${path}`);
    assert.ok(!files.some((f) => f.startsWith("src/")), "the package must distribute compiled code");
    writeFileSync(join(temp, "package.json"), JSON.stringify({ name: "code-dope-consumer", private: true, type: "module" }));
    execFileSync(npm, ["install", join(temp, packed.filename), "--no-audit", "--no-fund"], { cwd: temp, encoding: "utf8", timeout: 80_000 });
    const installed = JSON.parse(readFileSync(join(temp, "node_modules/code-dope/package.json"), "utf8"));
    assert.equal(installed.scripts.prepare, undefined);
    writeFileSync(join(temp, "consumer.mjs"), `
import assert from 'node:assert/strict';
import { createCodeRunner } from 'code-dope';
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from 'code-dope/mcp';
assert.equal(typeof createCodeModeMcpServer, 'function');
assert.equal(typeof createSearchExecuteMcpServer, 'function');
for (const isolation of ['inline', 'worker', 'pool']) {
  const runner = createCodeRunner({ tools: { svc: { read: () => 42 } }, policy: { read: ['read'] }, isolation, executor: { size: 1, idleMs: 50, timeoutMs: 3000 } });
  const result = await runner.run('async () => [await svc.read({}), typeof helpers.parallel]');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.result, [42, 'function']);
  assert.equal(result.audit[0].decision, 'allowed');
}
console.log('inline worker pool: OK');
`);
    const smoke = execFileSync(process.execPath, [join(temp, "consumer.mjs")], { cwd: temp, encoding: "utf8", timeout: 15_000 });
    assert.match(smoke, /inline worker pool: OK/);
    writeFileSync(join(temp, "consumer.ts"), `
import { createCodeRunner, PooledWorkerExecutor, type ToolPolicy } from 'code-dope';
import { createCodeModeMcpServer, createSearchExecuteMcpServer } from 'code-dope/mcp';
const policy: ToolPolicy = { read: ['read'], approve: ({ signal }) => !signal?.aborted };
const runner = createCodeRunner({ tools: { svc: { read: () => 42 } }, policy, isolation: 'worker' });
const pool = new PooledWorkerExecutor({ size: 1, prewarm: false });
const result = await runner.run('async () => svc.read({})');
const closed: boolean | undefined = result.audit[0]?.afterExecutionEnd;
void [closed, pool.close(), createCodeModeMcpServer, createSearchExecuteMcpServer];
`);
    const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "consumer.ts"], { cwd: temp, encoding: "utf8", timeout: 30_000 });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
