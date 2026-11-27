import { createDefaultExecutor } from "./executor/default.js";
import { createAuditLog, withPolicy } from "./policy.js";
export function createCodeRunner(o) {
    const executor = createDefaultExecutor(o.isolation, o.executor);
    const providers = Object.entries(o.tools).map(([name, fns]) => ({
        name,
        fns: Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, async (a) => f(a)])),
    }));
    let closed = false;
    let closing;
    return {
        async run(code) {
            if (closed) {
                return { result: undefined, error: "CodeRunner is closed", logs: [], audit: [], durationMs: 0 };
            }
            const log = createAuditLog();
            const userAudit = o.policy.audit;
            const guarded = withPolicy(executor, {
                ...o.policy,
                audit: (r) => {
                    log.sink(r);
                    if (userAudit) {
                        try {
                            void Promise.resolve(userAudit(r)).catch(() => { });
                        }
                        catch {
                            /* sink-owned delivery failure */
                        }
                    }
                },
            });
            const t = Date.now();
            const r = await guarded.execute(code, providers);
            return { ...r, audit: log.records, durationMs: Date.now() - t };
        },
        close() {
            if (closing)
                return closing;
            closed = true;
            closing = "close" in executor && typeof executor.close === "function"
                ? Promise.resolve(executor.close())
                : Promise.resolve();
            return closing;
        },
    };
}
