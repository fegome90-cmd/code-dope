/**
 * Policy layer: an Executor decorator that wraps every host tool function
 * BEFORE the sandbox can reach it. Because the guest can only call what the
 * executor exposes, programmatic calls are subject to exactly the same rules
 * as individual calls — they cannot bypass allowlists or approvals.
 *
 * Fail-closed defaults:
 *  - A tool must be classified as `read` or `write`; unclassified tools are denied.
 *  - `write` tools require `approve()` to return true; without it they are denied.
 *  - Call budget, per-call timeout and argument validation apply to every call.
 *
 * Works with any `Executor` (QuickJSExecutor, Cloudflare's DynamicWorkerExecutor, …).
 */
import type { ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";

export type ToolKind = "read" | "write";
type Fn = (...args: unknown[]) => Promise<unknown>;
type Fns = Record<string, Fn>;

/** A validator returns true/undefined when valid, or an error message. zod-like `safeParse` objects also work. */
export type ArgValidator =
  | ((args: unknown) => true | undefined | string)
  | { safeParse(args: unknown): { success: boolean; error?: { message: string } } };

export interface ApprovalRequest {
  provider: string;
  tool: string;
  args: unknown;
}

export interface AuditRecord {
  seq: number;
  provider: string;
  tool: string;
  kind: ToolKind | "unclassified";
  decision: "allowed" | "denied";
  reason?: string;
  ok?: boolean;
  error?: string;
  durationMs: number;
  argsChars: number;
  resultChars?: number;
}

export interface ToolPolicy {
  /** Tools without side effects. Names match `tool` or `provider.tool`. `"*"` matches all. */
  read?: string[];
  /** Tools with side effects. Each call needs `approve()` → true. */
  write?: string[];
  /** Always denied, evaluated first. */
  deny?: string[];
  /** Approval hook for write tools. Missing hook ⇒ writes denied. */
  approve?: (req: ApprovalRequest) => boolean | Promise<boolean>;
  /** Per-tool argument validators. */
  validate?: Record<string, ArgValidator>;
  /** Max host tool calls per execution. Default 50. */
  maxCalls?: number;
  /** Per-call timeout in ms. Default 15_000. */
  callTimeoutMs?: number;
  /** Max characters of a single tool result passed back to the guest. Default 1_000_000. */
  maxResultChars?: number;
  /** Receives one record per attempted call (allowed or denied). */
  audit?: (record: AuditRecord) => void;
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

function matches(list: string[] | undefined, provider: string, tool: string): boolean {
  if (!list) return false;
  return list.includes("*") || list.includes(tool) || list.includes(`${provider}.${tool}`);
}

function classify(p: ToolPolicy, provider: string, tool: string): ToolKind | "unclassified" {
  if (matches(p.write, provider, tool)) return "write";
  if (matches(p.read, provider, tool)) return "read";
  return "unclassified";
}

function runValidator(v: ArgValidator, args: unknown): string | undefined {
  if (typeof v === "function") {
    const r = v(args);
    return r === true || r === undefined ? undefined : r;
  }
  const r = v.safeParse(args);
  return r.success ? undefined : (r.error?.message ?? "invalid arguments");
}

function size(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new PolicyError(`Tool ${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Wrap one provider's fns with the policy. `state` is shared across providers of one execution. */
export function guardFns(provider: string, fns: Fns, policy: ToolPolicy, state = { calls: 0, seq: 0 }): Fns {
  const maxCalls = policy.maxCalls ?? 50;
  const callTimeoutMs = policy.callTimeoutMs ?? 15_000;
  const maxResultChars = policy.maxResultChars ?? 1_000_000;
  const out: Fns = {};
  for (const [tool, fn] of Object.entries(fns)) {
    out[tool] = async (args: unknown) => {
      const seq = ++state.seq;
      const kind = classify(policy, provider, tool);
      const started = Date.now();
      const base = { seq, provider, tool, kind, argsChars: size(args) };
      const deny = (reason: string): never => {
        policy.audit?.({ ...base, decision: "denied", reason, durationMs: Date.now() - started });
        throw new PolicyError(`Denied ${provider}.${tool}: ${reason}`);
      };

      if (matches(policy.deny, provider, tool)) deny("tool is on the deny list");
      if (kind === "unclassified") deny("tool is not classified as read or write (fail-closed)");
      if (state.calls >= maxCalls) deny(`call budget of ${maxCalls} exhausted`);
      const v = policy.validate?.[tool] ?? policy.validate?.[`${provider}.${tool}`];
      if (v) {
        const problem = runValidator(v, args);
        if (problem) deny(`invalid arguments: ${problem}`);
      }
      if (kind === "write") {
        if (!policy.approve) deny("write tool and no approval hook configured");
        const ok = await policy.approve!({ provider, tool, args });
        if (!ok) deny("approval rejected");
      }

      state.calls++;
      try {
        const result = await withTimeout(Promise.resolve(fn(args)), callTimeoutMs, `${provider}.${tool}`);
        const resultChars = size(result);
        if (resultChars > maxResultChars) {
          throw new PolicyError(`Result of ${provider}.${tool} is ${resultChars} chars (limit ${maxResultChars}); filter or paginate`);
        }
        policy.audit?.({ ...base, decision: "allowed", ok: true, durationMs: Date.now() - started, resultChars });
        return result;
      } catch (e) {
        policy.audit?.({ ...base, decision: "allowed", ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started });
        throw e;
      }
    };
  }
  return out;
}

/** Decorate any Executor so every tool function it receives is policy-guarded. */
export function withPolicy(inner: Executor, policy: ToolPolicy): Executor {
  return {
    async execute(code, providersOrFns, options): Promise<ExecuteResult> {
      // Cloudflare connector bindings are called by the sandbox over RPC and
      // would bypass these wrappers, so refuse them (fail-closed).
      if (options?.connectors?.length) {
        return { result: undefined, error: "withPolicy: connector bindings bypass the policy layer and are not allowed", logs: [] };
      }
      const state = { calls: 0, seq: 0 };
      const guarded: ResolvedProvider[] | Fns = Array.isArray(providersOrFns)
        ? providersOrFns.map((p) => ({ ...p, fns: guardFns(p.name, p.fns, policy, state) }))
        : guardFns("codemode", providersOrFns, policy, state);
      return inner.execute(code, guarded, options);
    },
  };
}

/** Simple in-memory audit sink. */
export function createAuditLog() {
  const records: AuditRecord[] = [];
  return {
    records,
    sink: (r: AuditRecord) => {
      records.push(r);
    },
    summary() {
      return {
        calls: records.filter((r) => r.decision === "allowed").length,
        denied: records.filter((r) => r.decision === "denied").length,
        errors: records.filter((r) => r.ok === false).length,
        resultChars: records.reduce((a, r) => a + (r.resultChars ?? 0), 0),
      };
    },
  };
}
