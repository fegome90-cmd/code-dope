/**
 * Recipes: parameterized, reusable multi-step workflows. Each builder returns
 * sandbox code (an async arrow function) that uses `helpers` and a tool
 * namespace. Parameters are embedded with JSON.stringify and identifiers are
 * validated, so recipe parameters cannot inject code.
 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function ident(name, label) {
    if (!IDENT.test(name))
        throw new Error(`${label} must be a JS identifier, got ${JSON.stringify(name)}`);
    return name;
}
const J = (v) => JSON.stringify(v);
function intWithMin(value, fallback, min, label) {
    const n = value === undefined ? fallback : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min) {
        throw new Error(`${label} must be a safe integer >= ${min}`);
    }
    return n;
}
function nonEmptyString(value, label) {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`${label} must be a nonempty string`);
    return value;
}
function optionalNonEmptyString(value, label) {
    return value === undefined ? undefined : nonEmptyString(value, label);
}
function plainObject(value, label) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null)
            return value;
    }
    throw new Error(`${label} must be a plain object`);
}
function optionalPlainObject(value, label) {
    return value === undefined ? undefined : plainObject(value, label);
}
function optionalStringArray(value, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array of nonempty strings`);
    const result = [];
    for (let i = 0; i < value.length; i++)
        result.push(nonEmptyString(value[i], label));
    return result;
}
/** List everything across pages, filter, project fields, return a compact summary. */
export const paginatedFilter = {
    id: "paginated-filter",
    summary: "Paginate a list tool, filter and project items in the sandbox, return count + sample (+ optional group counts).",
    build(p) {
        const ns = ident(p.namespace ?? "codemode", "namespace");
        const tool = ident(p.listTool, "listTool");
        const maxPages = intWithMin(p.maxPages, 20, 1, "maxPages");
        const sample = intWithMin(p.sample, 5, 0, "sample");
        const baseArgs = optionalPlainObject(p.baseArgs, "baseArgs");
        const where = optionalPlainObject(p.where, "where");
        const cursorArg = optionalNonEmptyString(p.cursorArg, "cursorArg");
        const itemsField = optionalNonEmptyString(p.itemsField, "itemsField");
        const nextField = optionalNonEmptyString(p.nextField, "nextField");
        const group = optionalNonEmptyString(p.groupBy, "groupBy");
        const fields = optionalStringArray(p.fields, "fields");
        return `async () => {
  const ev = helpers.evidence();
  const all = await helpers.paginate(
    (cursor) => ${ns}.${tool}({ ...${J(baseArgs ?? {})}, ...(cursor == null ? {} : { [${J(cursorArg ?? "cursor")}]: cursor }) }),
    { items: ${J(itemsField ?? "items")}, next: ${J(nextField ?? "next")}, maxPages: ${J(maxPages)} });
  ev.step("paginate", { pages: all.pages, items: all.items.length, truncated: all.truncated });
  const filtered = helpers.where(all.items, ${J(where ?? {})});
  ev.step("filter", { kept: filtered.length });
  const fields = ${J(fields ?? null)};
  const projected = fields ? helpers.pick(filtered, fields) : filtered;
  const groupBy = ${J(group ?? null)};
  return helpers.result(helpers.summarize(projected, { sample: ${J(sample)} }), { ok: !all.truncated,
    groups: groupBy ? helpers.countBy(filtered, groupBy) : undefined,
    truncated: all.truncated, evidence: ev.steps });
}`;
    },
};
/** List ids, fetch details in parallel with bounded concurrency, keep partial results. */
export const fanOutEnrich = {
    id: "fan-out-enrich",
    summary: "List items, fetch each detail in parallel (bounded), tolerate partial failures, return projected details + errors.",
    build(p) {
        const ns = ident(p.namespace ?? "codemode", "namespace");
        const list = ident(p.listTool, "listTool");
        const detail = ident(p.detailTool, "detailTool");
        const limit = intWithMin(p.limit, 50, 1, "limit");
        const concurrency = intWithMin(p.concurrency, 4, 1, "concurrency");
        const idField = nonEmptyString(p.idField, "idField");
        const detailArg = nonEmptyString(p.detailArg, "detailArg");
        const listArgs = optionalPlainObject(p.listArgs, "listArgs");
        const itemsField = optionalNonEmptyString(p.itemsField, "itemsField");
        const fields = optionalStringArray(p.fields, "fields");
        return `async () => {
  const ev = helpers.evidence();
  const listed = await ${ns}.${list}(${J(listArgs ?? {})});
  const items = (Array.isArray(listed) ? listed : (listed && listed[${J(itemsField ?? "items")}]) || []).slice(0, ${J(limit)});
  ev.step("list", { count: items.length });
  const ids = items.map((it) => it[${J(idField)}]);
  const results = await helpers.parallel(ids.map((id) => () => ${ns}.${detail}({ [${J(detailArg)}]: id })), { concurrency: ${J(concurrency)} });
  const { values, errors, complete } = helpers.settle(results);
  ev.step("details", { ok: values.length, failed: errors.length });
  const fields = ${J(fields ?? null)};
  return helpers.result(fields ? helpers.pick(values, fields) : values, {
    ok: complete, errors: errors.map((e) => ({ id: ids[e.index], error: e.error })), evidence: ev.steps });
}`;
    },
};
/** Find targets, then (unless dryRun) apply one write per target sequentially, stopping at the first failure. */
export const guardedBulkUpdate = {
    id: "guarded-bulk-update",
    summary: "Find targets, dry-run by default, cap the number of writes, apply sequentially and stop on first error.",
    build(p) {
        const ns = ident(p.namespace ?? "codemode", "namespace");
        const find = ident(p.findTool, "findTool");
        const update = ident(p.updateTool, "updateTool");
        const maxWrites = intWithMin(p.maxWrites, 20, 1, "maxWrites");
        const patch = plainObject(p.patch, "patch");
        const idField = nonEmptyString(p.idField, "idField");
        const idArg = nonEmptyString(p.idArg, "idArg");
        const findArgs = optionalPlainObject(p.findArgs, "findArgs");
        const itemsField = optionalNonEmptyString(p.itemsField, "itemsField");
        const dryRun = p.dryRun;
        if (dryRun !== undefined && typeof dryRun !== "boolean")
            throw new Error("dryRun must be a boolean");
        if (Object.hasOwn(patch, idArg))
            throw new Error(`patch must not contain the id argument "${idArg}"`);
        return `async () => {
  const ev = helpers.evidence();
  const found = await ${ns}.${find}(${J(findArgs ?? {})});
  const targets = (Array.isArray(found) ? found : (found && found[${J(itemsField ?? "items")}]) || []).map((t) => t[${J(idField)}]);
  ev.step("find", { targets: targets.length });
  const maxWrites = ${J(maxWrites)};
  if (targets.length > maxWrites) return helpers.result({ targets }, { ok: false, reason: "too many targets (" + targets.length + " > " + maxWrites + ")", evidence: ev.steps });
  if (${J(dryRun ?? true)}) return helpers.result({ wouldUpdate: targets, patch: ${J(patch)} }, { dryRun: true, evidence: ev.steps });
  const applied = [];
  for (const id of targets) {
    try {
      await ${ns}.${update}({ ...${J(patch)}, [${J(idArg)}]: id });
      applied.push(id);
    } catch (e) {
      const error = String(e.message || e);
      const stopped = { id, error, outcome: /timed out|timeout/i.test(error) ? "unknown" : "failed" };
      ev.step("stopped", stopped);
      return helpers.result({ applied, stopped, pending: targets.slice(applied.length + 1) }, { ok: false, evidence: ev.steps });
    }
  }
  ev.step("applied", { count: applied.length });
  return helpers.result({ applied }, { evidence: ev.steps });
}`;
    },
};
export const RECIPES = { paginatedFilter, fanOutEnrich, guardedBulkUpdate };
