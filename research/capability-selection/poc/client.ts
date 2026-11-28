import { readFileSync } from 'node:fs';
import { Validator, type Schema } from '@cfworker/json-schema';
import type { Executor, ResolvedProvider } from '@cloudflare/codemode';
import type { PooledWorkerExecutorOptions } from '../../../src/executor/pool-executor.ts';
import { collisions, policyAllows, withPolicy, createAuditLog, type ToolPolicy, type AuditRecord } from '../../../src/policy.ts';
import { capabilities, executeRequested, resolve, requestSchema } from '../selection.mjs';
import schema from './run.schema.json' with { type: 'json' };

type Route = 'direct' | 'native' | 'worker' | 'inline' | 'pool';
type Mode = 'off' | 'on' | 'auto';
export interface HostContext {
  mode: Mode;
  availableRoutes: Route[];
  allowedRoutes: Route[];
  revision: string;
  policyVersion: string;
  extendedAvailable: boolean;
  extendedAllowed: boolean;
}
type Operation = { kind: 'call'; provider: string; tool: string; args: unknown } | { kind: 'program'; code: string };
type RunConfig = { mode: Mode; request: { schemaVersion: 1; route: Route; telemetry?: 'minimal' | 'extended' }; operation: Operation };
export interface CapabilityHost {
  readContext: () => HostContext;
  providers: ResolvedProvider[];
  policy: ToolPolicy;
  catalog?: Array<{ provider: string; tool: string; description?: string; inputSchema?: unknown }>;
  executorOptions?: PooledWorkerExecutorOptions;
  native?: {
    // Import/prepare only: no tool calls or runtime initialization in load().
    load: () => Promise<Executor>;
    verification: 'VERIFIED' | 'NOT_VERIFIED';
  };
  extendedAudit?: (record: AuditRecord) => void;
}

const validator = new Validator(schema as unknown as Schema, '7');
validator.addSchema(requestSchema as Schema, 'urn:code-dope:selection-request');
const fail = (code: string): never => { throw new Error(code); };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const rejection = (error: unknown) => ({ ok: false as const, error: { code: message(error), message: message(error) }, audit: [] as AuditRecord[] });

function parseConfig(text: string): RunConfig {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 65_536) fail('INVALID_CONFIG');
  let config: unknown;
  try { config = JSON.parse(text); } catch { fail('INVALID_CONFIG'); }
  if (!validator.validate(config).valid) fail('INVALID_CONFIG');
  const c = config as RunConfig;
  if ((c.mode === 'off' && c.request.route !== 'direct') || (c.mode === 'on' && c.request.route === 'direct')) fail('MODE_CONFLICT');
  if ((c.request.route === 'direct') !== (c.operation.kind === 'call')) fail('OPERATION_CONFLICT');
  return c;
}

/** Research API. Host configuration is trusted; agent input is serialized data only. */
export function createCapabilityClient(host: CapabilityHost) {
  const context = () => {
    const c = host.readContext();
    if (c.availableRoutes?.includes('native') && !host.native) fail('INVALID_HOST_CONTEXT');
    return c;
  };
  const planFor = (c: RunConfig) => ({ ...resolve(JSON.stringify(c.request), context()),
    requestedMode: c.mode, selectorVersion: 'poc-v4' });
  const bindings = () => {
    const names = host.providers.map(p => p.name);
    if (new Set(names).size !== names.length) fail('DUPLICATE_PROVIDER');
    return host.providers;
  };
  const policyFor = (telemetry: string): ToolPolicy => ({ ...host.policy, audit: record => {
    // Return a single promise so the existing policy contains asynchronous sink errors.
    const sinks = [host.policy.audit, ...(telemetry === 'extended' ? [host.extendedAudit] : [])];
    return Promise.allSettled(sinks.map(sink => Promise.resolve().then(() => sink?.(record)))).then(() => {});
  } });
  return {
    capabilities() {
      try {
        const c = context();
        const effective = capabilities(c);
        const tools = bindings().flatMap(p => {
          const ambiguous = collisions(Object.keys(p.fns));
          return Object.keys(p.fns).filter(tool => policyAllows(host.policy, p.name, tool, ambiguous)).map(tool => {
            const metadata = host.catalog?.find(t => t.provider === p.name && t.tool === tool);
            return { provider: p.name, tool, ...(metadata?.description ? { description: metadata.description } : {}),
              ...(metadata?.inputSchema ? { inputSchema: metadata.inputSchema } : {}) };
          });
        });
        const catalog = JSON.parse(readFileSync(new URL('../../../catalog/patterns.json', import.meta.url), 'utf8'));
        return { ok: true as const, availableRoutes: [...c.availableRoutes], allowedRoutes: [...c.allowedRoutes],
          mandatory: { mode: c.mode, policy: true, approvalForWrites: true, audit: true }, effective, tools,
          patternCatalog: { version: catalog.version, patterns: catalog.patterns.map((p: { id: string; tasks: string[] }) => ({ id: p.id, tasks: p.tasks })) },
          nativeVerification: host.native?.verification ?? 'NOT_VERIFIED' };
      } catch (e) { return rejection(e); }
    },
    resolve(text: string) {
      try { return { ok: true as const, plan: planFor(parseConfig(text)) }; }
      catch (e) { return rejection(e); }
    },
    async run(text: string) {
      try {
        const c = parseConfig(text);
        const providers = bindings();
        type Selection = ReturnType<typeof planFor>;
        const receipt = (selected: Selection) => ({ ...selected, requestedMode: c.mode, selectorVersion: 'poc-v4' });
        const loaders = {
          direct: async () => {
            const { callDirect } = await import('./direct.ts');
            return async (op: Operation, selected: Selection) => {
              if (op.kind !== 'call') return fail('OPERATION_CONFLICT');
              return { ...await callDirect(op, providers, policyFor(selected.telemetry)), plan: receipt(selected) };
            };
          },
          native: async () => {
            const adapter = host.native;
            if (!adapter) return fail('UNAVAILABLE');
            const verification = adapter.verification;
            const executor = await adapter.load();
            return async (op: Operation, selected: Selection) => ({ ...await executeProgram(executor, op, selected.telemetry),
              plan: receipt(selected), nativeVerification: verification });
          },
          ...Object.fromEntries((['worker', 'inline', 'pool'] as const).map(route => [route, async () => {
            const { createDefaultExecutor } = await import('../../../src/executor/default.ts');
            return async (op: Operation, selected: Selection) => {
              // executeRequested has revalidated grants before this constructor can run.
              const executor = route === 'pool' ? createDefaultExecutor('pool', host.executorOptions) : createDefaultExecutor(route, host.executorOptions);
              let cleanupError: string | undefined;
              const result = await executeProgram(executor, op, selected.telemetry).finally(async () => {
                try { if ('close' in executor && typeof executor.close === 'function') await executor.close(); }
                catch (e) { cleanupError = message(e); }
              });
              return { ...result, plan: receipt(selected), ...(cleanupError !== undefined ? { cleanupError, error: result.error ?? cleanupError } : {}) };
            };
          }]))
        };
        async function executeProgram(executor: Executor, op: Operation, telemetry: string) {
          if (op.kind !== 'program') return fail('OPERATION_CONFLICT');
          const log = createAuditLog();
          const policy = policyFor(telemetry);
          const guarded = withPolicy(executor, { ...policy, audit: r => { log.sink(r); return policy.audit?.(r); } });
          let result;
          try { result = await guarded.execute(op.code, providers); }
          catch (e) { result = { result: undefined, error: message(e), logs: [] }; }
          return { ...result, audit: log.records, droppedAuditRecords: log.dropped };
        }
        const result = await executeRequested(JSON.stringify(c.request), context, loaders, c.operation);
        const { error, ...rest } = result;
        return { ...rest, ok: error === undefined, ...(error !== undefined ? { error: { code: 'EXECUTION_FAILED', message: error } } : {}),
          nativeVerification: result.nativeVerification ?? 'NOT_APPLICABLE' };
      } catch (e) { return rejection(e); }
    },
  };
}
