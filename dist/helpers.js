import { readFileSync } from "node:fs";
/** Source of src/sandbox/helpers.js — pass to QuickJSExecutor({ preludes: [SANDBOX_HELPERS] }) or a provider `prelude`. */
export const SANDBOX_HELPERS = readFileSync(new URL("./sandbox/helpers.js", import.meta.url), "utf8");
/** Short model-facing documentation appended to Code Mode tool descriptions. */
export const HELPERS_DOC = `Also available inside the sandbox: \`helpers\` (no imports, no timers):
- helpers.parallel(thunks, {concurrency=4}) -> [{ok,value}|{ok:false,error}]; helpers.settle(results) -> {values, errors, complete}
- helpers.paginate(cursor => tool(...), {items="items", next="next", maxPages=20}) -> {items, pages, truncated}
- helpers.batch(items, size, fn); helpers.retry(fn, {attempts=3}) — retry read tools only
- helpers.pick(objOrArray, ["a","b.c"]); helpers.where(items, {field: value|[values]|fn}); helpers.countBy(items, field)
- helpers.summarize(items, {sample=3}) -> {count, sample, omitted}; helpers.requireFields(obj, [...])
- helpers.evidence() -> {step(label, data), steps}; helpers.result(data, extra)
Return only what the user needs: filter and summarize before returning.`;
