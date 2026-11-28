import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const research = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));

function createScratch(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'verify-capability-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}

function runVerifier(cwd, scratch) {
  const env = { ...process.env, TMPDIR: scratch };
  // The verifier starts independent Node test runners.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('sh', ['verify.sh'], {
    cwd,
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
  return { run, receipt, current: steps.get('current-policy') };
}

test('the verifier records the real current policy result and runs the remaining gates', t => {
  const { run, receipt, current } = runVerifier(research, createScratch(t));
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

test('a controlled policy failure still runs later gates without masking the failure', t => {
  const scratch = createScratch(t);
  const fixture = join(scratch, 'research', 'capability-selection');
  cpSync(research, fixture, { recursive: true });
  for (const name of ['src', 'catalog', 'package.json']) {
    cpSync(join(repo, name), join(scratch, name), { recursive: true });
  }
  symlinkSync(join(repo, 'node_modules'), join(scratch, 'node_modules'), 'junction');

  // Replace only the intermediate test in the scratch copy; do not change the live policy.
  writeFileSync(join(fixture, 'tests/poc/current-policy-gate.test.mjs'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
for (let i = 1; i <= 4; i++) test('synthetic pass ' + i, () => {});
test('synthetic failure', () => assert.fail('controlled gate failure'));
`);

  const { run, receipt, current } = runVerifier(fixture, scratch);
  assert.deepEqual(
    [current.tests, current.pass, current.fail, current.exitCode, current.status, current.expectedKnownFailure],
    [5, 4, 1, 1, 'FAIL', false],
  );
  assert.equal(run.status, 1);
  assert.equal(receipt.status, 'FAIL');
  assert.match(receipt.error, /current-policy: 4\/5 passed/);
});
