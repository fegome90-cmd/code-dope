import { createDefaultExecutor } from "./executor/default.js";
import { createAuditLog, withPolicy } from "./policy.js";
export function createCodeRunner(o) {
    const executor = createDefaultExecutor(o.isolation, o.executor);
    const providers = Object.entries(o.tools).map(([name, fns]) => ({
        name,
        fns: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, async (a) => f(a)])),
    }));
    return {
        async run(code) {
            const log = createAuditLog();
            const userAudit = o.policy.audit;
            const guarded = withPolicy(executor, {
                ...o.policy,
                audit: (r) => {
                    log.sink(r);
                    userAudit?.(r);
                },
            });
            const t = Date.now();
            const r = await guarded.execute(code, providers);
            return { ...r, audit: log.records, durationMs: Date.now() - t };
        },
    };
}
