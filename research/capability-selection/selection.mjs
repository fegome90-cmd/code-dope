// Candidate: pure request/selection boundary. Not an authorization token.
import { Validator } from '@cfworker/json-schema';
export const ROUTES = Object.freeze(['direct', 'native', 'worker', 'inline', 'pool']);
const MODES = ['off', 'on', 'auto'];
const TELEMETRY = ['minimal', 'extended'];
const fail = code => { throw new Error(code); };
export const requestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'route'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    route: { enum: [...ROUTES] },
    telemetry: { enum: [...TELEMETRY] }
  }
};
const requestValidator = new Validator(requestSchema, '7');

// Only serialized input crosses this boundary; no accessors, functions or proxies.
export function parseRequest(text) {
  if (typeof text !== 'string' || text.length > 1024 || new TextEncoder().encode(text).byteLength > 1024) fail('INVALID_CONFIG');
  let x;
  try { x = JSON.parse(text); } catch { fail('INVALID_CONFIG'); }
  if (!requestValidator.validate(x).valid) fail('INVALID_CONFIG');
  return Object.freeze({ schemaVersion: 1, route: x.route,
    telemetry: Object.hasOwn(x, 'telemetry') ? x.telemetry : 'minimal' });
}

// env is supplied only by the host; revision covers grants, capabilities and policy.
function checkContext(env) {
  if (!env || !MODES.includes(env.mode) ||
      ![env.availableRoutes, env.allowedRoutes].every(a => Array.isArray(a) && a.every(r => ROUTES.includes(r))) ||
      typeof env.revision !== 'string' || !env.revision ||
      typeof env.policyVersion !== 'string' || !env.policyVersion ||
      typeof env.extendedAvailable !== 'boolean' || typeof env.extendedAllowed !== 'boolean') fail('INVALID_HOST_CONTEXT');
}
function routeFailure(route, env) {
  if ((env.mode === 'off' && route !== 'direct') || (env.mode === 'on' && route === 'direct')) return 'MODE_CONFLICT';
  if (!env.availableRoutes.includes(route)) return 'UNAVAILABLE';
  if (!env.allowedRoutes.includes(route)) return 'DENIED';
}
function select(request, env) {
  const { route, telemetry } = request;
  const problem = routeFailure(route, env);
  if (problem) fail(problem);
  if (telemetry === 'extended' && !env.extendedAvailable) fail('UNAVAILABLE_TELEMETRY');
  if (telemetry === 'extended' && !env.extendedAllowed) fail('DENIED_TELEMETRY');
  return Object.freeze({ ...request, mode: env.mode, policyVersion: env.policyVersion, revision: env.revision });
}
export function resolve(text, env) {
  const request = parseRequest(text);
  checkContext(env);
  return select(request, env);
}
export function capabilities(env) {
  checkContext(env);
  return Object.freeze({ revision: env.revision, mode: env.mode, routes: Object.freeze(ROUTES.filter(r => !routeFailure(r, env))),
    telemetry: Object.freeze(env.extendedAvailable && env.extendedAllowed ? [...TELEMETRY] : ['minimal']) });
}

// Host-owned loaders only. Loading must not initiate tool work; never trust a plan from a model.
// Actual authorization of each call remains with the selected adapter/host policy.
export async function executeRequested(text, readContext, loaders, input) {
  const before = resolve(text, readContext());
  if (!Object.hasOwn(loaders, before.route) || typeof loaders[before.route] !== 'function') fail('NO_ADAPTER');
  // The host supplies validated, data-only operation input. Freeze its intent across async loading.
  const snapshot = structuredClone(input);
  const invoke = await loaders[before.route]();
  const now = resolve(text, readContext());
  if (now.revision !== before.revision || now.policyVersion !== before.policyVersion || now.mode !== before.mode) fail('STALE_CONTEXT');
  if (typeof invoke !== 'function') fail('INVALID_ADAPTER');
  return invoke(snapshot, now); // No fallback/retry on failure, including unknown side effects.
}
