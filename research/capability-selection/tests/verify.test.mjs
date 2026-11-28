import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the verifier records current policy results, then runs the remaining gates', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'verify-capability-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: scratch };
  // The verifier starts independent Node test runners.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('sh', ['verify.sh'], {
    cwd: new URL('../', import.meta.url),
    env,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.ifError(run.error);
  const [runDir, ...extra] = readdirSync(scratch).filter(name => name.startsWith('code-dope-capability-'));
  assert.ok(runDir);
  assert.deepEqual(extra, []);
  const receipt = JSON.parse(readFileSync(join(scratch, runDir, 'receipt.json'), 'utf8'));
  const steps = new Map(receipt.steps.map(step => [step.name, step]));

  for (const name of ['poc-positive', 'poc-typecheck', 'baseline-contract-typecheck', 'experimental-patch', 'patched-positive', 'patched-policy-green']) {
    assert.equal(steps.get(name)?.status, 'PASS', `${name} must run even when the current policy fails: ${receipt.error ?? run.stderr}`);
  }
  assert.equal(steps.get('baseline-policy-red')?.expectedKnownFailure, true);
  const current = steps.get('current-policy');
  assert.equal(current?.tests, 5);
  assert.equal(current.pass + current.fail, 5);
  assert.equal(current.expectedKnownFailure, false);
  const passed = current.fail === 0;
  assert.equal(current.exitCode, passed ? 0 : 1);
  assert.equal(current.status, passed ? 'PASS' : 'FAIL');
  assert.equal(receipt.status, current.status);
  assert.equal(run.status, current.exitCode);
  assert.match(receipt.corePolicySha256, /^[a-f0-9]{64}$/);
});
