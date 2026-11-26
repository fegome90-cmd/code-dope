import { execFileSync } from 'node:child_process';

const OWNER = 'fegome90-cmd';
const REPOSITORY = 'code-dope';
const ROOT = `repos/${OWNER}/${REPOSITORY}`;
const REPO_ID = 1472983276;
const WORKFLOW_ID = 431459468;
const APP_ID = 15368;
const MAX_PAGE = 100;
const INITIAL = '148f09ad88e2a90e15f4b1f0f2c97e262a9f9dfa';
const BOOTSTRAP = '4d4ac6b4d4294a723171b8072f1d99f337b5a15d';
const PENDING = new Set(['queued', 'requested', 'pending', 'waiting', 'in_progress']);
const PROTECTED = new Set(['main', 'tester', 'developer']);
const STEPS = new Map([
  ['package', ['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm typecheck', 'pnpm test']],
  ['Secrets and private paths', ['Install verified Gitleaks', 'bash scripts/check-secrets.sh history']],
  ['Documentation links and references', ['node scripts/check-docs.mjs']],
]);
const THREADS_QUERY = `query ($number: Int!) {
  repository(owner: "fegome90-cmd", name: "code-dope") {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { isResolved }
      }
    }
  }
}`;
const SHA = /^[0-9a-f]{40}$/;
const isId = (n) => Number.isSafeInteger(n) && n > 0;
const isSha = (s) => typeof s === 'string' && SHA.test(s);

function requestGitHub(endpoint) {
  const threads = /^reviewThreads:([1-9][0-9]*)$/.exec(endpoint);
  const argv = threads
    ? ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${THREADS_QUERY}`, '-F', `number=${threads[1]}`]
    : ['api', '--hostname', 'github.com', '--method', 'GET', endpoint];
  return JSON.parse(execFileSync('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: '' },
  }));
}

function boundedList(array, total) {
  return Array.isArray(array) && array.length <= MAX_PAGE && total === array.length;
}

function identityOf(pr, integration) {
  return {
    number: pr.number,
    headRepoId: pr.head?.repo?.id,
    baseRepoId: pr.base?.repo?.id,
    headRef: pr.head?.ref,
    baseRef: pr.base?.ref,
    headSha: pr.head?.sha,
    baseSha: pr.base?.sha,
    ...(integration ? { mergeSha: integration.sha, treeSha: integration.tree.sha } : {}),
  };
}

function belongsTo(entry, identity) {
  return entry?.number === identity.number
    && entry.head?.repo?.id === identity.headRepoId && entry.base?.repo?.id === identity.baseRepoId
    && entry.head?.ref === identity.headRef && entry.base?.ref === identity.baseRef
    && entry.head?.sha === identity.headSha && entry.base?.sha === identity.baseSha;
}

function currentThreads(value) {
  if (value?.errors?.length) return 'unknown';
  const threads = value?.data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(threads?.nodes) || threads.nodes.length > MAX_PAGE) return 'unknown';
  if (threads.nodes.some((thread) => thread?.isResolved === false)) return 'unresolved';
  return threads.pageInfo?.hasNextPage === false
    && threads.nodes.every((thread) => thread?.isResolved === true) ? 'resolved' : 'unknown';
}

function reviewsClear(reviews) {
  if (!Array.isArray(reviews) || reviews.length >= MAX_PAGE) return undefined;
  const decisive = new Map();
  for (const review of reviews) {
    if (!isId(review?.user?.id) || !isId(review.id) || typeof review.state !== 'string') return undefined;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    if ((decisive.get(review.user.id)?.id ?? 0) < review.id) decisive.set(review.user.id, review);
  }
  return [...decisive.values()].some((review) => review.state === 'CHANGES_REQUESTED');
}

function strictRules(rules, branch) {
  if (!Array.isArray(rules)) return false;
  const active = rules.filter((rule) => rule?.ruleset_id === 28158227);
  const types = new Set(active.map((rule) => rule.type));
  const pr = active.find((rule) => rule.type === 'pull_request')?.parameters;
  const checks = active.find((rule) => rule.type === 'required_status_checks')?.parameters;
  return PROTECTED.has(branch) && ['deletion', 'non_fast_forward'].every((type) => types.has(type))
    && pr?.required_review_thread_resolution === true
    && checks?.strict_required_status_checks_policy === true
    && Array.isArray(checks.required_status_checks)
    && checks.required_status_checks.length === STEPS.size
    && [...STEPS.keys()].every((name) => checks.required_status_checks.filter(
      (check) => check.context === name && check.integration_id === APP_ID,
    ).length === 1);
}

function executed(job) {
  return (STEPS.get(job?.name) ?? []).length > 0 && Array.isArray(job.steps)
    && STEPS.get(job.name).every((expect) => job.steps.some((step) =>
      [expect, `Run ${expect}`].includes(step.name)
      && step.status === 'completed' && step.conclusion === 'success'));
}

function matchCheck(check, job, run, sha) {
  return isId(check?.id) && check.name === job.name && check.head_sha === sha
    && check.app?.id === APP_ID && check.status === job.status && check.conclusion === job.conclusion
    && check.check_suite?.id === run.check_suite_id
    && check.details_url === `https://github.com/${OWNER}/${REPOSITORY}/actions/runs/${run.id}/job/${job.id}`;
}

async function integrationOf(read, pr) {
  if (!isSha(pr.merge_commit_sha) || !isSha(pr.head?.sha) || !isSha(pr.base?.sha)) return undefined;
  const ref = await read(`${ROOT}/git/ref/pull/${pr.number}/merge`);
  if (ref?.ref !== `refs/pull/${pr.number}/merge` || ref.object?.sha !== pr.merge_commit_sha) return undefined;
  const commit = await read(`${ROOT}/git/commits/${pr.merge_commit_sha}`);
  if (commit?.sha !== ref.object.sha || commit.parents?.length !== 2 || !isSha(commit.tree?.sha)
      || commit.parents[0]?.sha !== pr.base.sha || commit.parents[1]?.sha !== pr.head.sha) return undefined;
  return commit;
}

function candidateRun(list, identity) {
  if (!boundedList(list?.workflow_runs, list?.total_count)) return undefined;
  const candidates = [];
  for (const run of list.workflow_runs) {
    if (!Array.isArray(run?.pull_requests) || run.pull_requests.length !== 1
      || !isId(run.pull_requests[0]?.number)) return undefined;
    if (run.pull_requests[0].number === identity.number) candidates.push(run);
  }
  if (candidates.length !== 1) return undefined;
  const [run] = candidates;
  if (!isId(run?.id) || !isId(run.run_attempt) || !isId(run.check_suite_id)
    || run.head_sha !== identity.headSha || run.workflow_id !== WORKFLOW_ID || run.event !== 'pull_request'
    || run.repository?.id !== REPO_ID || run.head_repository?.id !== REPO_ID
    || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1
    || !belongsTo(run.pull_requests[0], identity)) return undefined;
  return run;
}

async function readCI(read, identity) {
  if (!isSha(identity.headSha) || !isSha(identity.mergeSha) || !isSha(identity.treeSha)) return {};
  const run = candidateRun(await read(
    `${ROOT}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${identity.headSha}&per_page=${MAX_PAGE}`,
  ), identity);
  if (!run) return {};
  const receipt = {
    headSha: identity.headSha, baseSha: identity.baseSha, mergeSha: identity.mergeSha, treeSha: identity.treeSha,
    workflowId: WORKFLOW_ID, event: 'pull_request', appId: APP_ID,
    runId: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion,
  };
  if (PENDING.has(run.status) && run.conclusion == null) {
    const latest = await read(`${ROOT}/actions/runs/${run.id}`);
    if (latest?.status !== run.status || latest?.run_attempt !== run.run_attempt
      || latest?.check_suite_id !== run.check_suite_id || latest?.conclusion != null
      || !candidateRun({ workflow_runs: [latest], total_count: 1 }, identity)) return {};
    return { ci: { ...receipt, jobs: [] } };
  }
  const [jobs, checkRuns] = await Promise.all([
    read(`${ROOT}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${MAX_PAGE}`),
    read(`${ROOT}/commits/${identity.mergeSha}/check-runs?filter=latest&per_page=${MAX_PAGE}`),
  ]);
  if (!boundedList(jobs?.jobs, jobs?.total_count)
    || !boundedList(checkRuns?.check_runs, checkRuns?.total_count)
    || jobs.jobs.length !== STEPS.size || new Set(jobs.jobs.map((job) => job.name)).size !== STEPS.size
    || !jobs.jobs.every((job) => STEPS.has(job.name) && isId(job.id) && job.run_id === run.id
      && job.run_attempt === run.run_attempt)) return {};
  const hasExactChecks = (checks, sha) => boundedList(checks?.check_runs, checks?.total_count)
    && jobs.jobs.every((job) => checks.check_runs.filter((check) => matchCheck(check, job, run, sha)).length === 1);
  const mergeChecksMatch = hasExactChecks(checkRuns, identity.mergeSha);
  if (!mergeChecksMatch && checkRuns.total_count !== 0) return {};
  if (!mergeChecksMatch) {
    const headChecks = await read(`${ROOT}/commits/${identity.headSha}/check-runs?filter=latest&per_page=${MAX_PAGE}`);
    if (!hasExactChecks(headChecks, identity.headSha)) return {};
  }
  const currentRun = await read(`${ROOT}/actions/runs/${run.id}`);
  if (!currentRun || ['id', 'run_attempt', 'check_suite_id', 'status', 'conclusion'].some(
    (key) => currentRun[key] !== run[key],
  ) || candidateRun({ workflow_runs: [currentRun], total_count: 1 }, identity) === undefined) return {};
  // Candidate workflow logs are not trusted provenance for the checked-out commit.
  if (!mergeChecksMatch) return { ciEvidenceGap: 'HEAD_CHECKS_ONLY' };
  return {
    ci: {
      ...receipt,
      jobs: jobs.jobs.map(({ name, status, conclusion, ...rest }) =>
        ({ name, status, conclusion, executed: executed({ name, steps: rest.steps }) })),
    },
    integrationProven: true,
  };
}

export async function collectSnapshot(prNumber, { request = requestGitHub, intent = 'normal' } = {}) {
  if (!isId(prNumber) || prNumber > 2147483647 || prNumber === 2) throw new Error('PR fuera del alcance autorizado.');
  if (!['normal', 'bootstrap', 'sync'].includes(intent)) throw new Error('Intención no reconocida.');
  const read = async (endpoint) => {
    try { return await request(endpoint); }
    catch { return undefined; }
  };

  const endpoint = `${ROOT}/pulls/${prNumber}`;
  const initial = await read(endpoint);
  const assurance = { effectiveRules: false, integrationProven: false, workflowTrusted: false };
  const result = { identity: { number: prNumber }, intent, conversations: 'unknown', assurance };
  if (!initial || initial.number !== prNumber) return result;
  result.identity = identityOf(initial);
  result.state = initial.state;
  result.draft = initial.draft;
  if (initial.state !== 'open' || initial.draft === true) return result;
  if (!PROTECTED.has(initial.base?.ref) || initial.base?.repo?.id !== REPO_ID
    || initial.head?.repo?.id !== REPO_ID) return result;

  const [integration, threads, reviews, files, rules] = await Promise.all([
    integrationOf(read, initial),
    read(`reviewThreads:${prNumber}`),
    read(`${endpoint}/reviews?per_page=${MAX_PAGE}`),
    read(`${endpoint}/files?per_page=${MAX_PAGE}`),
    read(`${ROOT}/rules/branches/${initial.base.ref}`),
  ]);
  result.identity = identityOf(initial, integration);
  result.conversations = currentThreads(threads);
  const changesRequested = reviewsClear(reviews);
  if (typeof changesRequested === 'boolean') result.changesRequested = changesRequested;
  if (boundedList(files, initial.changed_files)
    && files.every((file) => typeof file?.filename === 'string'
      && (file.status !== 'renamed' || typeof file.previous_filename === 'string'))) {
    result.changedFiles = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  }
  assurance.effectiveRules = strictRules(rules, initial.base.ref);

  const ci = await readCI(read, result.identity);
  if (ci.ci) result.ci = ci.ci;
  if (ci.ciEvidenceGap) result.ciEvidenceGap = ci.ciEvidenceGap;
  assurance.integrationProven = ci.integrationProven === true;
  if (intent === 'bootstrap') {
    result.bootstrap = { mainSha: BOOTSTRAP, initialSha: INITIAL };
    const id = result.identity;
    if (id.baseSha === INITIAL && isSha(id.headSha) &&
        ((id.headRef === 'main' && id.baseRef === 'tester' && id.headSha === BOOTSTRAP) ||
         (id.headRef === 'tester' && id.baseRef === 'developer'))) {
      const [headCommit, mainCommit] = await Promise.all([
        read(`${ROOT}/git/commits/${id.headSha}`), read(`${ROOT}/git/commits/${BOOTSTRAP}`),
      ]);
      assurance.bootstrapVerified = headCommit?.sha === id.headSha && mainCommit?.sha === BOOTSTRAP
        && isSha(mainCommit.tree?.sha) && headCommit.tree?.sha === mainCommit.tree.sha
        && id.treeSha === mainCommit.tree.sha && headCommit.parents?.[0]?.sha === INITIAL
        && (id.headRef === 'main' || (headCommit.parents.length === 2 && headCommit.parents[1]?.sha === BOOTSTRAP));
    }
    assurance.integrationProven &&= assurance.bootstrapVerified === true;
  }

  const latest = await read(endpoint);
  if (latest?.number === prNumber && (latest.state !== initial.state || latest.draft !== initial.draft)) {
    result.state = latest.state;
    result.draft = latest.draft;
  }
  if (latest?.number === prNumber) {
    const [currentIntegration, baseRef] = await Promise.all([
      integrationOf(read, latest),
      PROTECTED.has(latest.base?.ref) ? read(`${ROOT}/git/ref/heads/${latest.base.ref}`) : undefined,
    ]);
    result.currentIdentity = identityOf(latest, currentIntegration);
    if (isSha(baseRef?.object?.sha) && baseRef.ref === `refs/heads/${latest.base?.ref}`) {
      result.currentIdentity.baseSha = baseRef.object.sha;
    } else {
      delete result.currentIdentity.baseSha;
    }
  }
  return result;
}
