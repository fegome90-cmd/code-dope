import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, REPO_ID, WORKFLOW_ID, evaluate, isControlPath } from "./evaluate.mjs";

const sha = c => c.repeat(40);
const initial = "148f09ad88e2a90e15f4b1f0f2c97e262a9f9dfa";
const bootstrap = "4d4ac6b4d4294a723171b8072f1d99f337b5a15d";
const trueAssurance = { effectiveRules: true, integrationProven: true, workflowTrusted: true };
const fixture = (identityOverrides = {}) => {
  const identity = {
    number: 8, headRepoId: REPO_ID, baseRepoId: REPO_ID,
    headRef: "feat/receipt", baseRef: "developer",
    headSha: sha("a"), baseSha: sha("b"), mergeSha: sha("c"), treeSha: sha("d"),
    ...identityOverrides,
  };
  return {
    identity, currentIdentity: { ...identity }, intent: "normal", state: "open", draft: false,
    conversations: "resolved", changesRequested: false, changedFiles: ["src/receipt.mjs"],
    assurance: { ...trueAssurance },
    ci: {
      headSha: identity.headSha, baseSha: identity.baseSha,
      mergeSha: identity.mergeSha, treeSha: identity.treeSha,
      workflowId: WORKFLOW_ID, appId: 15368, event: "pull_request", runId: 71, attempt: 1,
      status: "completed", conclusion: "success",
      jobs: CHECKS.map(name => ({ name, status: "completed", conclusion: "success", executed: true })),
    },
    approval: { issuer: "maintainer", identity: { ...identity }, method: "squash" },
  };
};
const wait = f => Object.assign(f.ci, { status: "in_progress", conclusion: null });
const expect = (f, status, reason) => {
  const result = evaluate(f);
  assert.equal(result.status, status);
  assert.equal(result.reason, reason);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(result.nextStep.length > 0);
  return result;
};

test("all gates current -> READY for report only", () => {
  expect(fixture(), "READY", "EVIDENCE_AND_APPROVAL");
});
test("a valid promotion from tester to main requires a merge commit", () => {
  const f = fixture({ headRef: "tester", baseRef: "main" });
  expect(f, "NEEDS_HUMAN", "APPROVAL_MISSING");
  f.approval.method = "merge";
  expect(f, "READY", "EVIDENCE_AND_APPROVAL");
});
test("matching running CI -> WAIT and safe run receipt, stale approval does not mask it", () => {
  const f = fixture();
  wait(f);
  f.approval.identity.baseSha = sha("e");
  const r = expect(f, "WAIT_CI", "CI_PENDING");
  assert.deepEqual([r.runId, r.attempt], [71, 1]);
});
test("invalid promotion wins over running CI", () => {
  const f = fixture({ baseRef: "main" });
  wait(f);
  expect(f, "FIX_REQUIRED", "WRONG_ROUTE");
});
test("same-name fork rejected", () => {
  const f = fixture({ headRepoId: 500, headRef: "developer", baseRef: "tester" });
  expect(f, "FIX_REQUIRED", "WRONG_REPOSITORY");
});
test("draft and closed states never request approval", () => {
  const f = fixture();
  f.draft = true;
  expect(f, "FIX_REQUIRED", "PR_DRAFT");
  f.state = "closed";
  expect(f, "FIX_REQUIRED", "PR_CLOSED");
});
test("required job failed while CI is in progress", () => {
  const f = fixture();
  wait(f);
  f.ci.jobs[0].conclusion = "failure";
  expect(f, "FIX_REQUIRED", "CI_FAILED");
});
test("skipped and neutral jobs are not green", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const f = fixture();
    f.ci.jobs[0].conclusion = conclusion;
    expect(f, "FIX_REQUIRED", "CI_FAILED");
  }
});
test("missing, duplicated, or unexecuted job evidence does not authorize", () => {
  for (const mode of ["missing", "duplicate", "unexecuted"]) {
    const f = fixture();
    if (mode === "missing") f.ci.jobs.pop();
    if (mode === "duplicate") f.ci.jobs.push(f.ci.jobs[0]);
    if (mode === "unexecuted") f.ci.jobs[0].executed = false;
    expect(f, "BLOCKED_EVIDENCE", "CI_INCOMPLETE");
  }
});
test("old green attached to other HEAD, base, tree or merge commit is stale", () => {
  for (const key of ["headSha", "baseSha", "treeSha", "mergeSha"]) {
    const f = fixture();
    f.ci[key] = sha("e");
    expect(f, "STALE", "CI_IDENTITY_MISMATCH");
  }
});
test("current identity drift on re-read is stale, malformed read is blocked", () => {
  const f = fixture();
  f.currentIdentity.mergeSha = sha("e");
  expect(f, "STALE", "IDENTITY_CHANGED");
  f.currentIdentity.mergeSha = "invalid";
  expect(f, "BLOCKED_EVIDENCE", "OBSERVATIONS_INCOMPLETE");
});
test("other workflow, triggering event, or app cannot authenticate a CI result", () => {
  for (const [key, value] of [["appId", 1], ["workflowId", 2], ["event", "push"], ["attempt", 0]]) {
    const f = fixture();
    f.ci[key] = value;
    expect(f, "BLOCKED_EVIDENCE", "OBSERVATIONS_INCOMPLETE");
  }
});
test("unresolved review is a fix; unknown review is missing evidence", () => {
  const f = fixture();
  f.conversations = "unresolved";
  expect(f, "FIX_REQUIRED", "REVIEW_UNRESOLVED");
  f.conversations = "unknown";
  expect(f, "BLOCKED_EVIDENCE", "OBSERVATIONS_INCOMPLETE");
});
test("running CI does not outrank unresolved review", () => {
  const f = fixture();
  wait(f);
  f.changesRequested = true;
  expect(f, "FIX_REQUIRED", "REVIEW_UNRESOLVED");
});
test("current approval must come from trusted caller for exact candidate and method", () => {
  const f = fixture();
  delete f.approval;
  expect(f, "NEEDS_HUMAN", "APPROVAL_MISSING");
  f.approval = { issuer: "maintainer", identity: { ...f.identity, baseSha: sha("e") }, method: "squash" };
  expect(f, "NEEDS_HUMAN", "APPROVAL_MISSING");
});
test("control paths need separate review pinned to this candidate", () => {
  const f = fixture();
  f.changedFiles = [".github/workflows/check.yml"];
  expect(f, "NEEDS_HUMAN", "CONTROL_REVIEW_MISSING");
  f.controlReview = { issuer: "independent", identity: { ...f.identity, headSha: sha("e") } };
  expect(f, "NEEDS_HUMAN", "CONTROL_REVIEW_MISSING");
  f.controlReview.identity = { ...f.identity };
  expect(f, "READY", "EVIDENCE_AND_APPROVAL");
  f.assurance.workflowTrusted = false;
  expect(f, "BLOCKED_EVIDENCE", "WORKFLOW_PROVENANCE_UNVERIFIED");
});
test("bootstrap is explicit and pinned; later tester step needs inclusion evidence", () => {
  const f = fixture({ headRef: "main", baseRef: "tester", headSha: bootstrap, baseSha: initial });
  expect(f, "FIX_REQUIRED", "WRONG_ROUTE");
  f.intent = "bootstrap";
  f.approval.method = "merge";
  expect(f, "READY", "EVIDENCE_AND_APPROVAL");
  const second = fixture({ headRef: "tester", baseRef: "developer", baseSha: initial });
  second.intent = "bootstrap";
  second.approval.method = "merge";
  expect(second, "BLOCKED_EVIDENCE", "BOOTSTRAP_UNVERIFIED");
  second.assurance.bootstrapVerified = true;
  expect(second, "READY", "EVIDENCE_AND_APPROVAL");
  const offAnchor = fixture({ headRef: "main", baseRef: "tester", baseSha: initial });
  offAnchor.intent = "bootstrap";
  expect(offAnchor, "FIX_REQUIRED", "WRONG_ROUTE");
});
test("back-sync is an explicit intent and requires the proof of integration", () => {
  const f = fixture({ headRef: "main", baseRef: "developer" });
  f.intent = "sync";
  f.approval.method = "merge";
  expect(f, "READY", "EVIDENCE_AND_APPROVAL");
  f.assurance.integrationProven = false;
  expect(f, "BLOCKED_EVIDENCE", "ASSURANCE_INCOMPLETE");
});
test("fingerprints are stable, distinguish attempts, and do not echo raw inputs", () => {
  const f = fixture({ headRef: "feat/benign-marker" });
  wait(f);
  const one = evaluate(f);
  assert.deepEqual(one, evaluate(JSON.parse(JSON.stringify(f))));
  assert.ok(!JSON.stringify(one).includes("benign-marker"));
  f.ci.attempt += 1;
  assert.notEqual(one.fingerprint, evaluate(f).fingerprint);
});
test("non-path fields and malformed evidence cannot produce READY", () => {
  const f = fixture();
  delete f.changedFiles;
  expect(f, "BLOCKED_EVIDENCE", "ASSURANCE_INCOMPLETE");
  expect(null, "BLOCKED_EVIDENCE", "IDENTITY_INCOMPLETE");
  for (const path of [".github/anything", "scripts/go.js", "pnpm-lock.yaml", ".gitleaks.toml",
    ".node-version", "tsconfig.json", ".gitattributes", "package.json", "docs/CODEOWNERS"]) {
    assert.equal(isControlPath(path), true);
  }
  assert.equal(isControlPath("src/module.mjs"), false);
});

test("known base drift is stale even when the new merge identity is unknown", () => {
  const f = fixture();
  f.currentIdentity = { baseSha: sha("e") };
  expect(f, "STALE", "IDENTITY_CHANGED");
});

test("head-only CI evidence names the gap without approving integration", () => {
  const f = fixture();
  delete f.ci;
  f.ciEvidenceGap = "HEAD_CHECKS_ONLY";
  expect(f, "BLOCKED_EVIDENCE", "HEAD_CHECKS_ONLY");
});
