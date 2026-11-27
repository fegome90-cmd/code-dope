import type { Executor, ResolvedProvider } from '@cloudflare/codemode';
import { withPolicy, createAuditLog, type ToolPolicy } from '../../../src/policy.ts';

export type DirectCall = { provider: string; tool: string; args: unknown };

// Adapted from fixtures/baseline/direct.ts; this imports the current core policy.
export async function callDirect(call: DirectCall, providers: ResolvedProvider[], policy: ToolPolicy) {
  const { provider, tool, args } = call;
  const audit = createAuditLog();
  const inner: Executor = { async execute(_code, guarded) {
    try {
      if (!Array.isArray(guarded)) throw new Error('EXPECTED_PROVIDERS');
      const matches = guarded.filter(p => p.name === provider);
      if (matches.length !== 1 || !Object.hasOwn(matches[0].fns, tool) || typeof matches[0].fns[tool] !== 'function')
        throw new Error('UNKNOWN_OR_AMBIGUOUS_TOOL');
      const result = await matches[0].fns[tool](args);
      if (result === undefined) return { result, logs: [] };
      const json = JSON.stringify(result);
      if (json === undefined) throw new Error('RESULT_NOT_JSON');
      return { result: JSON.parse(json), logs: [] };
    } catch (e) {
      return { result: undefined, error: e instanceof Error ? e.message : String(e), logs: [] };
    }
  } };
  const guarded = withPolicy(inner, { ...policy, audit: r => { audit.sink(r); return policy.audit?.(r); } });
  return { ...await guarded.execute('', providers), audit: audit.records, droppedAuditRecords: audit.dropped };
}
