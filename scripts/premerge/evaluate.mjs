import { createHash } from "node:crypto";

export const REPO_ID = 1472983276;
export const WORKFLOW_ID = 431459468;
export const CHECKS = Object.freeze([
  "package",
  "Secrets and private paths",
  "Documentation links and references",
]);

const ACTIONS_APP_ID = 15368;
const MAIN_BOOTSTRAP = "4d4ac6b4d4294a723171b8072f1d99f337b5a15d";
const INITIAL_BRANCH = "148f09ad88e2a90e15f4b1f0f2c97e262a9f9dfa";
const SHA = /^[a-f0-9]{40}$/;
const WORK_REF = /^(?:feat|fix|chore|docs|refactor|test|ci|perf)\/[a-zA-Z0-9._/-]+$/;
const ID_KEYS = [
  "number", "headRepoId", "baseRepoId", "headRef", "baseRef",
  "headSha", "baseSha", "mergeSha", "treeSha",
];
const CI_KEYS = ["headSha", "baseSha", "mergeSha", "treeSha"];
const PENDING = new Set(["queued", "requested", "pending", "waiting", "in_progress"]);

export function isControlPath(path) {
  return /^(?:\.github\/|scripts\/|tests\/|\.husky\/)/.test(path) ||
    /^(?:package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|\.npmrc|\.pnpmfile\.(?:cjs|mjs)|pnpm-workspace\.yaml|\.gitleaks\.toml|\.gitleaksignore|\.node-version|\.nvmrc|tsconfig(?:\..+)?\.json|\.gitattributes|\.gitignore|CODEOWNERS|docs\/CODEOWNERS)$/.test(path);
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validSha = value => typeof value === "string" && SHA.test(value);
const ref = value => typeof value === "string" && value.trim() === value &&
  value.length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/.test(value);

function complete(identity) {
  return object(identity) && ["number", "headRepoId", "baseRepoId"].every(k => positive(identity[k])) &&
    ["headRef", "baseRef"].every(k => ref(identity[k])) && CI_KEYS.every(k => validSha(identity[k]));
}

function sameIdentity(left, right) {
  return complete(left) && complete(right) && ID_KEYS.every(key => left[key] === right[key]);
}

function route(identity, intent) {
  const { headRef, baseRef, headSha, baseSha } = identity;
  if (!ref(headRef) || !ref(baseRef)) return undefined;
  if (intent === "normal") {
    if (WORK_REF.test(headRef) && baseRef === "developer") return "squash";
    if ((headRef === "developer" && baseRef === "tester") ||
        (headRef === "tester" && baseRef === "main")) return "merge";
  } else if (intent === "bootstrap") {
    if (!validSha(headSha) || !validSha(baseSha)) return undefined;
    if (baseSha === INITIAL_BRANCH &&
        ((headRef === "main" && baseRef === "tester" && headSha === MAIN_BOOTSTRAP) ||
         (headRef === "tester" && baseRef === "developer" &&
          headSha !== INITIAL_BRANCH && headSha !== MAIN_BOOTSTRAP))) return "merge";
  } else if (intent === "sync") {
    if (baseRef === "developer" && (headRef === "main" || headRef === "tester")) return "merge";
  } else return undefined;
  return null;
}

const requiredFailure = (ci) => ci.status === "completed" && ci.conclusion !== "success" &&
    typeof ci.conclusion === "string" ||
  Array.isArray(ci.jobs) && ci.jobs.some(job =>
    object(job) && CHECKS.includes(job.name) && job.status === "completed" &&
    typeof job.conclusion === "string" && job.conclusion !== "success");

const allJobsPassed = jobs => Array.isArray(jobs) && CHECKS.every(name => {
  const matches = jobs.filter(job => object(job) && job.name === name);
  return matches.length === 1 && matches[0].status === "completed" &&
    matches[0].conclusion === "success" && matches[0].executed === true;
});

export function evaluate(snapshot) {
  const s = object(snapshot) ? snapshot : {};
  const { identity: id, currentIdentity, ci, assurance, approval, controlReview } = s;
  const fingerprintKeys = complete(id) ? ID_KEYS.map(key => id[key]) : [];
  const proof = object(ci) && ci.workflowId === WORKFLOW_ID && ci.appId === ACTIONS_APP_ID &&
    ci.event === "pull_request" && positive(ci.runId) && positive(ci.attempt);
  const matched = complete(id) && proof && CI_KEYS.every(key => ci[key] === id[key]);
  const receipt = matched ? { runId: ci.runId, attempt: ci.attempt } : {};
  const decision = (status, reason, nextStep) => ({
    status, reason, nextStep, ...receipt,
    fingerprint: createHash("sha256").update(
      JSON.stringify([1, ...fingerprintKeys, receipt.runId, receipt.attempt, status, reason]),
    ).digest("hex"),
  });
  const missing = (reason, step) => decision("BLOCKED_EVIDENCE", reason, step);
  const fix = (reason, step) => decision("FIX_REQUIRED", reason, step);
  const stale = (reason, step) => decision("STALE", reason, step);

  if (s.state === "closed") return fix("PR_CLOSED", "Usa un PR abierto y permitido.");
  if (s.draft === true) return fix("PR_DRAFT", "Mantén el borrador hasta que esté listo para revisión.");
  if (!object(id)) return missing("IDENTITY_INCOMPLETE", "Obtén la identidad del PR.");
  if ([id.baseRepoId, id.headRepoId].some(value => positive(value) && value !== REPO_ID)) {
    return fix("WRONG_REPOSITORY", "Usa una rama del repositorio permitido.");
  }
  const method = route(id, s.intent);
  if (method === null) return fix("WRONG_ROUTE", "Usa la ruta de promoción o sincronización documentada.");
  if (s.changesRequested === true || s.conversations === "unresolved") {
    return fix("REVIEW_UNRESOLVED", "Resuelve las observaciones de revisión antes de continuar.");
  }
  if (!complete(id) || !method || s.state !== "open" || s.draft !== false) {
    return missing("IDENTITY_INCOMPLETE", "Obtén la identidad completa del candidato y su estado.");
  }
  const fieldValid = (key, value) => CI_KEYS.includes(key) ? validSha(value) :
    (key === "headRef" || key === "baseRef" ? ref(value) : positive(value));
  if (object(currentIdentity) && ID_KEYS.some(key =>
    fieldValid(key, currentIdentity[key]) && currentIdentity[key] !== id[key])) {
    return stale("IDENTITY_CHANGED", "Repite la lectura del candidato vigente.");
  }
  if (proof && CI_KEYS.some(key => validSha(ci[key]) && ci[key] !== id[key])) {
    return stale("CI_IDENTITY_MISMATCH", "Obtén la corrida exacta del candidato vigente.");
  }
  if (matched && requiredFailure(ci)) {
    return fix("CI_FAILED", "Revisa la corrida y corrige los checks fallidos.");
  }
  if (complete(currentIdentity) && s.conversations === "resolved" &&
      s.changesRequested === false && !matched && s.ciEvidenceGap === "HEAD_CHECKS_ONLY") {
    return missing("HEAD_CHECKS_ONLY", "GitHub vincula los checks al HEAD; verifica por separado el árbol de integración.");
  }
  if (!complete(currentIdentity) || s.conversations !== "resolved" ||
      s.changesRequested !== false || !matched) {
    return missing("OBSERVATIONS_INCOMPLETE", "Obtén la relectura, revisión y CI verificables.");
  }
  if (s.intent === "bootstrap" && id.headRef === "tester" && assurance?.bootstrapVerified !== true) {
    return missing("BOOTSTRAP_UNVERIFIED", "Verifica contenido y ascendencia del bootstrap en tester.");
  }
  if (PENDING.has(ci.status) && ci.conclusion == null) {
    return decision("WAIT_CI", "CI_PENDING", "Espera la corrida identificada; no dispares otra.");
  }
  if (ci.status !== "completed" || ci.conclusion !== "success" || !allJobsPassed(ci.jobs)) {
    return missing("CI_INCOMPLETE", "Comprueba ejecución exitosa y no duplicada de cada check requerido.");
  }
  if (assurance?.effectiveRules !== true || assurance?.integrationProven !== true ||
      !Array.isArray(s.changedFiles) ||
      s.changedFiles.some(path => typeof path !== "string" || !path)) {
    return missing("ASSURANCE_INCOMPLETE", "Verifica reglas, árbol, procedencia del workflow y archivos modificados.");
  }
  if (assurance?.workflowTrusted !== true) {
    return missing("WORKFLOW_PROVENANCE_UNVERIFIED",
      "Contrasta el workflow y sus controles con una fuente confiable antes de promover.");
  }
  if (s.changedFiles.some(isControlPath) &&
      (controlReview?.issuer !== "independent" || !sameIdentity(id, controlReview.identity))) {
    return decision("NEEDS_HUMAN", "CONTROL_REVIEW_MISSING",
      "Obtén una revisión independiente, fijada al candidato, de los cambios de control.");
  }
  if (approval?.issuer !== "maintainer" || approval.method !== method ||
      !sameIdentity(id, approval.identity)) {
    return decision("NEEDS_HUMAN", "APPROVAL_MISSING", "Solicita autorización para este PR, destino, método y SHAs.");
  }
  return decision("READY", "EVIDENCE_AND_APPROVAL", "Conserva el recibo; este verificador no fusiona.");
}
