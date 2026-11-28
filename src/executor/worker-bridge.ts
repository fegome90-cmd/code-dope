/**
 * Parent-side half of the worker tool bridge, shared by WorkerExecutor and
 * PooledWorkerExecutor. The worker sends {provider, tool, args}; the parent runs
 * the real tool function (credentials stay here) and replies with JSON data only.
 */
import type { ResolvedProvider } from "../types.ts";

export type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;
export interface CallMsg { type: "call"; job?: number; id: number; provider: string; tool: string; args: unknown }
export interface ReplyMsg { type: "reply"; job?: number; id: number; ok: boolean; value?: unknown; error?: string }
export interface ProviderSpec { name: string; tools: string[]; prelude?: string }

export function toProviders(p: ResolvedProvider[] | Fns): ResolvedProvider[] {
  return Array.isArray(p) ? p : [{ name: "codemode", fns: p }];
}

/** What the worker needs to rebuild provider proxies: names only, never functions. */
export function providerSpecs(providers: ResolvedProvider[]): ProviderSpec[] {
  return providers.map((p) => ({ name: p.name, tools: Object.keys(p.fns), prelude: p.prelude }));
}

/** Runs one forwarded tool call in the parent and builds the reply message. Never throws. */
export async function runCall(byName: Map<string, Fns>, m: CallMsg): Promise<ReplyMsg> {
  const fn = byName.get(m.provider)?.[m.tool];
  try {
    if (!fn) throw new Error(`Unknown tool: ${m.provider}.${m.tool}`);
    const value = await fn(m.args);
    return { type: "reply", job: m.job, id: m.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null") };
  } catch (e) {
    return { type: "reply", job: m.job, id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
