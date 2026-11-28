import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const output = mkdtempSync(join(tmpdir(), 'code-dope-capability-'));
const scratch = join(output, 'patched');
const receipts = [];
const manifest = JSON.parse(readFileSync(join(here, 'source-manifest.json'), 'utf8'));
const hash = (kind, bytes) => createHash(kind).update(bytes).digest('hex');
const sourceHashes = manifest.filter(s => s.gitBlob).map(source => {
  const bytes = readFileSync(join(here, source.local));
  const gitBlob = hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  const sha256 = hash('sha256', bytes);
  assert.equal(gitBlob, source.gitBlob, source.local); assert.equal(sha256, source.sha256, source.local);
  return { file: source.local, gitBlob, sha256 };
});
assert.equal(sourceHashes.length, 3, 'verify all three pinned original sources');
const originalPolicyHash = hash('sha256', readFileSync(join(root, 'src/policy.ts')));

function step(name, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? here, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, `${name}.log`), log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].flatMap(key => {
    const match = log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return match ? [[key, Number(match[1])]] : [];
  }));
  const receipt = { name, command: [command === process.execPath ? 'node' : command, ...args.map(a => a.replace(root, '<repo>').replace(scratch, '<patched>'))],
    exitCode: result.status, ...counts, status: result.status === 0 ? 'PASS' : 'FAIL', expectedKnownFailure: options.red ?? false };
  receipts.push(receipt); console.log(JSON.stringify(receipt));
  if (options.red) {
    assert.equal(result.status, 1, name); assert.equal(counts.tests, 5, name); assert.equal(counts.fail, 5, name);
    assert.equal((log.match(/^not ok \d+ - policy fail-closed:/gm) ?? []).length, 5, name);
  } else assert.equal(result.status, 0, `${name}: ${log.slice(-2000)}`);
  return log;
}

try {
  const versions = { node: process.version, npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    cfworker: JSON.parse(readFileSync(join(root, 'node_modules/@cfworker/json-schema/package.json'), 'utf8')).version,
    typescript: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version };
  writeFileSync(join(output, 'environment.json'), JSON.stringify(versions, null, 2) + '\n');
  step('schema-parity', 'python3', ['schema-parity.py']);
  const baselineArgs = ['--test', '--test-reporter=tap', 'tests/selection.test.mjs', 'tests/direct.test.mjs'];
  step('baseline-positive', process.execPath, baselineArgs);
  step('baseline-policy-red', process.execPath, ['--test', '--test-reporter=tap', 'tests/policy-gate.test.mjs'], { red: true });
  step('current-policy-red', process.execPath, ['--test', '--test-reporter=tap', 'tests/poc/current-policy-gate.test.mjs'], { red: true });
  step('poc-positive', process.execPath, ['--test', '--test-reporter=tap', 'tests/poc/integration.test.mjs', 'tests/poc/cli.test.mjs', 'tests/poc/lazy-loading.test.mjs']);
  step('poc-typecheck', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.poc.json']);
  step('baseline-contract-typecheck', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.contract.json']);
  mkdirSync(scratch);
  for (const name of ['fixtures', 'tests', 'selection.mjs', 'package.json', 'policy-validation-experiment.patch']) cpSync(join(here, name), join(scratch, name), { recursive: true });
  // Reuse only the repository's frozen installation; no install or second lockfile.
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  step('experimental-patch', 'git', ['apply', 'policy-validation-experiment.patch'], { cwd: scratch });
  step('patched-positive', process.execPath, baselineArgs, { cwd: scratch });
  step('patched-policy-green', process.execPath, ['--test', '--test-reporter=tap', 'tests/policy-gate.test.mjs'], { cwd: scratch });
  assert.equal(hash('sha256', readFileSync(join(root, 'src/policy.ts'))), originalPolicyHash, 'current core must stay unchanged');
  for (const source of sourceHashes) assert.equal(hash('sha256', readFileSync(join(here, source.file))), source.sha256, 'baseline sources must stay unchanged');
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ status: 'PASS', meaning: 'PoC gates passed; expected current-core failures remain FAIL', versions, sourceHashes, corePolicySha256: originalPolicyHash, steps: receipts }, null, 2) + '\n');
  console.log('PoC verification PASS; baseline/current core each retain five known FAIL results.');
} catch (error) {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ status: 'FAIL', error: String(error), sourceHashes, steps: receipts }, null, 2) + '\n');
  console.error(error.message); process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Evidence: ${output}`);
}
