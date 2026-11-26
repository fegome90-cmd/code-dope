import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSnapshot } from './github.mjs';

const ROOT = 'repos/fegome90-cmd/code-dope';
const ID = 1472983276;
const APP = 15368;
const WF = 431459468;
const prPath = ROOT + '/pulls/3';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const specs = {
  package: ['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm typecheck', 'pnpm test'],
  'Secrets and private paths': ['Install verified Gitleaks', 'bash scripts/check-secrets.sh history'],
  'Documentation links and references': ['node scripts/check-docs.mjs'],
};
const runPath = ROOT + '/actions/runs/11';
const runsPath = ROOT + '/actions/workflows/' + WF + '/runs?event=pull_request&head_sha=' + HEAD + '&per_page=100';
const jobsPath = runPath + '/attempts/1/jobs?per_page=100';
const checksPath = ROOT + '/commits/' + MERGE + '/check-runs?filter=latest&per_page=100';

function fixture() {
  const pr = {
    number: 3, state: 'open', draft: false, merge_commit_sha: MERGE, changed_files: 1,
    head: { repo: { id: ID }, ref: 'developer', sha: HEAD },
    base: { repo: { id: ID }, ref: 'tester', sha: BASE },
  };
  const run = {
    id: 11, run_attempt: 1, check_suite_id: 12, status: 'completed', conclusion: 'success',
    head_sha: HEAD, workflow_id: WF, event: 'pull_request',
    repository: { id: ID }, head_repository: { id: ID },
    pull_requests: [{ number: pr.number, head: pr.head, base: pr.base }],
  };
  const jobs = Object.entries(specs).map(([name, steps], i) => ({
    id: 20 + i, name, run_id: 11, run_attempt: 1, status: 'completed', conclusion: 'success',
    steps: steps.map((name) => ({ name: `Run ${name}`, status: 'completed', conclusion: 'success' })),
  }));
  const checks = jobs.map((job, i) => ({
    id: 40 + i, name: job.name, head_sha: MERGE, status: 'completed', conclusion: 'success',
    app: { id: APP }, check_suite: { id: 12 },
    details_url: `https://github.com/fegome90-cmd/code-dope/actions/runs/11/job/${job.id}`,
  }));
  const replies = new Map([
    [prPath, pr],
    [ROOT + '/git/ref/pull/3/merge', { ref: 'refs/pull/3/merge', object: { sha: MERGE } }],
    [ROOT + '/git/commits/' + MERGE, { sha: MERGE, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: HEAD }] }],
    [ROOT + '/git/ref/heads/tester', { ref: 'refs/heads/tester', object: { sha: BASE } }],
    ['reviewThreads:3', { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false },
    } } } } }],
    [prPath + '/reviews?per_page=100', []],
    [prPath + '/files?per_page=100', [{ filename: 'README.md' }]],
    [ROOT + '/rules/branches/tester', [
      { type: 'deletion', ruleset_id: 28158227 },
      { type: 'non_fast_forward', ruleset_id: 28158227 },
      { type: 'pull_request', ruleset_id: 28158227, parameters: { required_review_thread_resolution: true } },
      { type: 'required_status_checks', ruleset_id: 28158227, parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: Object.keys(specs).map((context) => ({ context, integration_id: APP })),
      } },
    ]],
    [runsPath, { total_count: 1, workflow_runs: [run] }],
    [jobsPath, { total_count: jobs.length, jobs }],
    [checksPath, { total_count: checks.length, check_runs: checks }],
    [runPath, run],
  ]);
  const calls = [];
  return {
    replies, calls, pr, run, jobs, checks,
    request(endpoint) {
      calls.push(endpoint);
      assert(replies.has(endpoint), 'fixture endpoint must be explicitly provided');
      const v = replies.get(endpoint);
      if (v instanceof Error) throw v;
      return structuredClone(typeof v === 'function' ? v() : v);
    },
  };
}

test('excludes PR #2 and malformed input before any reads', async () => {
  let calls = 0;
  const options = { request: () => { calls++; } };
  for (const n of [2, -1, 0, 2.1, '3', Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    await assert.rejects(collectSnapshot(n, options), /fuera del alcance/);
  }
  await assert.rejects(collectSnapshot(3, { ...options, intent: 'unknown' }), /no reconocida/);
  assert.equal(calls, 0);
});

test('normalizes an exact two-parent integration and CI receipt without trusting workflow or authority', async () => {
  const f = fixture();
  const s = await collectSnapshot(3, f);
  assert.deepEqual(s.currentIdentity, s.identity);
  assert.deepEqual(s.identity, {
    number: 3, headRepoId: ID, baseRepoId: ID, headRef: 'developer', baseRef: 'tester',
    headSha: HEAD, baseSha: BASE, mergeSha: MERGE, treeSha: TREE,
  });
  assert.deepEqual(s.assurance, { effectiveRules: true, integrationProven: true, workflowTrusted: false });
  assert.equal(s.conversations, 'resolved');
  assert.equal(s.changesRequested, false);
  assert.deepEqual(s.changedFiles, ['README.md']);
  assert.equal(s.ci.attempt, 1);
  assert(s.ci.jobs.every(({ executed }) => executed));
  assert.equal(s.approval, undefined);
  assert.equal(s.controlReview, undefined);
  assert.equal(f.calls.filter((p) => p === prPath).length, 2);
});

test('only waits on a proved matching pending run without inventing executed jobs', async () => {
  const f = fixture();
  f.run.status = 'queued';
  f.run.conclusion = null;
  const s = await collectSnapshot(3, f);
  assert.equal(s.ci.status, 'queued');
  assert.deepEqual(s.ci.jobs, []);
  assert.equal(s.assurance.integrationProven, false);
  assert(!f.calls.includes(jobsPath));
});

test('detects changed base on reread even if PR payload lags', async () => {
  const f = fixture();
  f.replies.get(ROOT + '/git/ref/heads/tester').object.sha = 'e'.repeat(40);
  const s = await collectSnapshot(3, f);
  assert.equal(s.currentIdentity.baseSha, 'e'.repeat(40));
  assert.equal(s.identity.baseSha, BASE);
});

test('draft or excluded repository performs no unnecessary secondary reads', async () => {
  for (const modify of [(p) => { p.draft = true; }, (p) => { p.state = 'closed'; },
    (p) => { p.head.repo.id = ID + 1; }]) {
    const f = fixture();
    modify(f.pr);
    const s = await collectSnapshot(3, f);
    assert.equal(s.assurance.integrationProven, false);
    assert.deepEqual(f.calls, [prPath]);
  }
});

test('partial pages and failed reads give unknown or incomplete rather than success', async () => {
  const f = fixture();
  f.replies.get('reviewThreads:3').data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true;
  f.pr.changed_files = 101;
  f.replies.set(prPath + '/reviews?per_page=100', new Error('untrusted body not for display'));
  f.replies.get(jobsPath).total_count = 101;
  const s = await collectSnapshot(3, f);
  assert.equal(s.conversations, 'unknown');
  assert.equal(s.changesRequested, undefined);
  assert.equal(s.changedFiles, undefined);
  assert.equal(s.ci, undefined);
  assert(!JSON.stringify(s).includes('untrusted body'));
});

test('stale attempts, duplicate runs and checks from other apps never stand in for the CI receipt', async () => {
  for (const bad of [
    (f) => { f.replies.set(runPath, { ...f.run, run_attempt: 2 }); },
    (f) => { f.replies.set(runsPath, { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 13 }] }); },
    (f) => { f.checks[0].app.id = APP + 1; },
    (f) => { f.run.pull_requests[0].base = { ...f.pr.base, sha: 'e'.repeat(40) }; },
  ]) {
    const f = fixture();
    bad(f);
    const s = await collectSnapshot(3, f);
    assert.equal(s.ci, undefined);
    assert.equal(s.assurance.integrationProven, false);
  }
});

test('completed success without critical steps is not recorded as execution success', async () => {
  const f = fixture();
  f.jobs[0].steps.pop();
  const s = await collectSnapshot(3, f);
  assert.equal(s.ci.jobs.find((job) => job.name === 'package').executed, false);
});

test('unresolved threads are visible even when the rest of the page is unavailable', async () => {
  const f = fixture();
  const threads = f.replies.get('reviewThreads:3').data.repository.pullRequest.reviewThreads;
  threads.nodes = [{ isResolved: false }];
  threads.pageInfo.hasNextPage = true;
  const s = await collectSnapshot(3, f);
  assert.equal(s.conversations, 'unresolved');
});

test('the read adapter returns no raw error even when initial read fails', async () => {
  const s = await collectSnapshot(3, { request: () => { throw new Error('raw provider error'); } });
  assert.deepEqual(s.identity, { number: 3 });
  assert(!JSON.stringify(s).includes('raw provider error'));
});

test('ignores another identified PR sharing the same head without accepting ambiguous identity', async () => {
  const f = fixture();
  f.replies.set(runsPath, { total_count: 2, workflow_runs: [
    { ...f.run, id: 13, pull_requests: [{ ...f.run.pull_requests[0], number: 4 }] }, f.run,
  ] });
  const s = await collectSnapshot(3, f);
  assert.equal(s.ci.runId, 11);
  f.replies.get(runsPath).workflow_runs[0].pull_requests = [];
  assert.equal((await collectSnapshot(3, f)).ci, undefined);
});

test('exact check runs on HEAD alone never attest the merge checkout or create a CI receipt', async () => {
  const f = fixture();
  const headPath = ROOT + '/commits/' + HEAD + '/check-runs?filter=latest&per_page=100';
  const headChecks = f.checks.map((check) => ({ ...check, head_sha: HEAD }));
  f.replies.set(checksPath, { total_count: 0, check_runs: [] });
  f.replies.set(headPath, { total_count: headChecks.length, check_runs: headChecks });
  const s = await collectSnapshot(3, f);
  assert.equal(s.ciEvidenceGap, 'HEAD_CHECKS_ONLY');
  assert.equal(s.ci, undefined);
  assert.equal(s.assurance.integrationProven, false);
  assert.equal(s.assurance.workflowTrusted, false);
  assert(f.calls.includes(headPath));
  assert(!f.calls.some((endpoint) => endpoint.endsWith('/logs')));
  headChecks[0].check_suite.id++;
  assert.equal((await collectSnapshot(3, f)).ciEvidenceGap, undefined);
});
