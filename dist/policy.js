import { sanitizeToolName } from "./vendor/cf-utils.js";
export class PolicyError extends Error {
    name = "PolicyError";
}
/** Real names that share a sanitized alias with a different tool in one provider. */
export function collisions(names) {
    const groups = new Map();
    for (const name of new Set(names)) {
        const alias = sanitizeToolName(name);
        const group = groups.get(alias) ?? [];
        group.push(name);
        groups.set(alias, group);
    }
    return new Set([...groups.values()].filter((group) => group.length > 1).flat());
}
/** Reject single-catalog rules that look qualified but actually name a dotted tool. */
export function validatePolicyPrefixes(policy, providers) {
    const providerNames = new Set(providers.map((provider) => provider.name));
    const rules = [
        ...(policy.deny ?? []).map((entry) => ({ entry, isDeny: true })),
        ...[...(policy.read ?? []), ...(policy.write ?? []), ...Object.keys(policy.validate ?? {})]
            .map((entry) => ({ entry, isDeny: false })),
    ];
    const catalog = providers.map(({ name, fns }) => {
        const names = Object.keys(fns);
        return { provider: name, names, ambiguous: collisions(names) };
    });
    for (const { entry, isDeny } of rules) {
        const dot = entry.indexOf(".");
        if (dot <= 0)
            continue;
        const prefix = entry.slice(0, dot);
        if (providerNames.has(prefix))
            continue;
        const alias = sanitizeToolName(entry);
        for (const { provider, names, ambiguous } of catalog) {
            for (const tool of names) {
                const sanitizedHit = (isDeny || !ambiguous.has(tool)) && tool.includes(".") && sanitizeToolName(tool) === alias;
                if (tool === entry || sanitizedHit) {
                    throw new PolicyError(`Policy rule ${JSON.stringify(entry)} uses unknown provider prefix ${JSON.stringify(prefix)} while matching tool ${JSON.stringify(tool)}; qualify it as ${JSON.stringify(`${provider}.${tool}`)}`);
                }
            }
        }
    }
}
/** Exact allowlist matching for ambiguous names; deny lists always use sanitization. */
export function matches(list, provider, tool, { exact = false } = {}) {
    if (!list)
        return false;
    const t = sanitizeToolName(tool);
    return list.some((e) => {
        if (e === "*")
            return !exact;
        const dot = e.indexOf(".");
        if (dot > 0 && e.slice(0, dot) !== provider)
            return false;
        const name = dot > 0 ? e.slice(dot + 1) : e;
        return exact ? name === tool : sanitizeToolName(name) === t;
    });
}
function findValidator(p, provider, tool, exact) {
    if (!p.validate)
        return undefined;
    for (const [k, v] of Object.entries(p.validate))
        if (matches([k], provider, tool, { exact }))
            return v;
    return undefined;
}
function classify(p, provider, tool, exact) {
    if (matches(p.write, provider, tool, { exact }))
        return "write";
    if (matches(p.read, provider, tool, { exact }))
        return "read";
    return "unclassified";
}
/** Whether a tool can be advertised; approval and validation still apply at invocation. */
export function policyAllows(p, provider, tool, ambiguous) {
    return !matches(p.deny, provider, tool) && classify(p, provider, tool, ambiguous.has(tool)) !== "unclassified";
}
function runValidator(v, args) {
    if (typeof v === "function") {
        const r = v(args);
        if (r === true || r === undefined)
            return undefined;
        if (typeof r === "string")
            return r.length > 0 ? r : "invalid arguments";
        return "invalid arguments";
    }
    const r = v.safeParse(args);
    if (typeof r !== "object" || r === null)
        return "invalid arguments";
    const { success } = r;
    if (success === true)
        return undefined;
    if (success !== false)
        return "invalid arguments";
    const message = r.error?.message;
    return typeof message === "string" && message.length > 0 ? message : "invalid arguments";
}
function size(v) {
    try {
        return JSON.stringify(v)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
function withTimeout(p, ms, label, onTimeout) {
    let t;
    return Promise.race([
        p,
        new Promise((_, rej) => {
            t = setTimeout(() => {
                onTimeout();
                rej(new PolicyError(`Tool ${label} timed out after ${ms}ms (side effects may still complete)`));
            }, ms);
        }),
    ]).finally(() => clearTimeout(t));
}
/** Wrap one provider's fns. Without a shared execution state, the guards never close. */
export function guardFns(provider, fns, policy, state = { calls: 0, seq: 0, closed: false, abort: new AbortController() }) {
    const maxCalls = policy.maxCalls ?? 50;
    const callTimeoutMs = policy.callTimeoutMs ?? 15_000;
    const maxResultChars = policy.maxResultChars ?? 1_000_000;
    const ambiguous = collisions(Object.keys(fns));
    const audit = (record) => {
        // A logging outage cannot turn a completed write into a retryable failure,
        // or replace the original denial. Also contain asynchronous sink rejection.
        try {
            void Promise.resolve(policy.audit?.(record)).catch(() => { });
        }
        catch { /* sink-owned delivery failure */ }
    };
    const out = {};
    for (const [tool, fn] of Object.entries(fns)) {
        out[tool] = async (args) => {
            const seq = ++state.seq;
            const exact = ambiguous.has(tool);
            const kind = classify(policy, provider, tool, exact);
            const started = Date.now();
            const base = { seq, provider, tool, kind, argsChars: size(args) };
            const deny = (reason) => {
                audit({ ...base, decision: "denied", reason, durationMs: Date.now() - started });
                throw new PolicyError(`Denied ${provider}.${tool}: ${reason}`);
            };
            if (state.closed)
                deny("execution already finished");
            if (matches(policy.deny, provider, tool))
                deny("tool is on the deny list");
            if (kind === "unclassified") {
                const other = exact ? [...ambiguous].find((name) => name !== tool && sanitizeToolName(name) === sanitizeToolName(tool)) : undefined;
                const detail = other === undefined ? "" : `; ${JSON.stringify(tool)} collides with ${JSON.stringify(other)} after sanitization; name it exactly in the policy`;
                deny(`tool is not classified as read or write (fail-closed)${detail}`);
            }
            // Reserve the budget slot synchronously, before any await, so concurrent
            // calls cannot all pass the check while an async approval is pending.
            if (state.calls >= maxCalls)
                deny(`call budget of ${maxCalls} exhausted`);
            state.calls++;
            let reservedReleased = false;
            const release = () => {
                if (!reservedReleased) {
                    reservedReleased = true;
                    state.calls--;
                }
            };
            // Snapshot once for execution; neither the caller nor either hook keeps
            // the object that will reach the tool. Hooks get independent copies.
            let executionArgs;
            try {
                executionArgs = structuredClone(args);
            }
            catch {
                release();
                deny("arguments are not cloneable");
            }
            const v = findValidator(policy, provider, tool, exact);
            if (v) {
                let problem;
                try {
                    problem = runValidator(v, structuredClone(executionArgs));
                }
                catch (e) {
                    problem = `validator threw: ${e instanceof Error ? e.message : String(e)}`;
                }
                if (problem !== undefined) {
                    release();
                    deny(`invalid arguments: ${problem}`);
                }
            }
            if (kind === "write") {
                if (!policy.approve) {
                    release();
                    deny("write tool and no approval hook configured");
                }
                let ok = false;
                try {
                    ok = (await policy.approve({ provider, tool, args: structuredClone(executionArgs), signal: state.abort?.signal })) === true;
                }
                catch (e) {
                    release();
                    deny(`approval hook failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                if (!ok) {
                    release();
                    deny("approval rejected");
                }
            }
            if (state.closed) {
                release();
                deny("execution already finished");
            }
            let timedOut = false;
            try {
                const result = await withTimeout(Promise.resolve(fn(executionArgs)), callTimeoutMs, `${provider}.${tool}`, () => {
                    timedOut = true;
                });
                const resultChars = size(result);
                if (resultChars > maxResultChars) {
                    throw new PolicyError(`Result of ${provider}.${tool} is ${resultChars} chars (limit ${maxResultChars}); filter or paginate`);
                }
                audit({ ...base, decision: "allowed", ok: true, outcome: "done", durationMs: Date.now() - started, resultChars, ...(state.closed ? { afterExecutionEnd: true } : {}) });
                return result;
            }
            catch (e) {
                audit({
                    ...base, decision: "allowed", ok: false, outcome: timedOut ? "unknown" : "failed",
                    error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started,
                    ...(state.closed ? { afterExecutionEnd: true } : {}),
                });
                throw e;
            }
        };
    }
    return out;
}
/** Decorate any Executor so every tool function it receives is policy-guarded. */
export function withPolicy(inner, policy) {
    return {
        async execute(code, providersOrFns, options) {
            // Cloudflare connector bindings are called by the sandbox over RPC and
            // would bypass these wrappers, so refuse them (fail-closed).
            if (options?.connectors?.length) {
                return { result: undefined, error: "withPolicy: connector bindings bypass the policy layer and are not allowed", logs: [] };
            }
            if (!Array.isArray(providersOrFns)) {
                try {
                    validatePolicyPrefixes(policy, [{ name: "codemode", fns: providersOrFns }]);
                }
                catch (e) {
                    if (e instanceof PolicyError)
                        return { result: undefined, error: `PolicyError: ${e.message}`, logs: [] };
                    throw e;
                }
            }
            const state = { calls: 0, seq: 0, closed: false, abort: new AbortController() };
            const guarded = Array.isArray(providersOrFns)
                ? providersOrFns.map((p) => ({ ...p, fns: guardFns(p.name, p.fns, policy, state) }))
                : guardFns("codemode", providersOrFns, policy, state);
            try {
                return await inner.execute(code, guarded, options);
            }
            finally {
                state.closed = true;
                state.abort.abort();
            }
        },
    };
}
/** In-memory audit sink. Keeps the first `maxRecords` records and counts the rest. */
export function createAuditLog(maxRecords = 1_000) {
    const records = [];
    let dropped = 0;
    return {
        records,
        get dropped() {
            return dropped;
        },
        sink: (r) => {
            if (records.length < maxRecords)
                records.push(r);
            else
                dropped++;
        },
        summary() {
            return {
                dropped,
                calls: records.filter((r) => r.decision === "allowed").length,
                denied: records.filter((r) => r.decision === "denied").length,
                errors: records.filter((r) => r.ok === false).length,
                resultChars: records.reduce((a, r) => a + (r.resultChars ?? 0), 0),
            };
        },
    };
}
