export function toProviders(p) {
    return Array.isArray(p) ? p : [{ name: "codemode", fns: p }];
}
/** What the worker needs to rebuild provider proxies: names only, never functions. */
export function providerSpecs(providers) {
    return providers.map((p) => ({ name: p.name, tools: Object.keys(p.fns), prelude: p.prelude }));
}
/** Runs one forwarded tool call in the parent and builds the reply message. Never throws. */
export async function runCall(byName, m) {
    const fn = byName.get(m.provider)?.[m.tool];
    try {
        if (!fn)
            throw new Error(`Unknown tool: ${m.provider}.${m.tool}`);
        const value = await fn(m.args);
        return { type: "reply", job: m.job, id: m.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null") };
    }
    catch (e) {
        return { type: "reply", job: m.job, id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
