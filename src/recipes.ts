/**
 * Recipes: parameterized, reusable multi-step workflows. Each builder returns
 * sandbox code (an async arrow function) that uses `helpers` and a tool
 * namespace. Parameters are embedded with JSON.stringify and identifiers are
 * validated, so recipe parameters cannot inject code.
 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function ident(name: string, label: string): string {
  if (!IDENT.test(name)) throw new Error(`${label} must be a JS identifier, got ${JSON.stringify(name)}`);
  return name;
}
const J = (v: unknown) => JSON.stringify(v);

export interface Recipe<P> {
  id: string;
  summary: string;
  build(params: P): string;
}

export interface PaginatedFilterParams {
  namespace?: string;
  /** Paginated list tool. Called as tool({ ...baseArgs, [cursorArg]: cursor }). */
  listTool: string;
  baseArgs?: Record<string, unknown>;
  cursorArg?: string;
  itemsField?: string;
  nextField?: string;
  maxPages?: number;
  where?: Record<string, unknown>;
  fields?: string[];
  groupBy?: string;
  sample?: number;
}

/** List everything across pages, filter, project fields, return a compact summary. */
export const paginatedFilter: Recipe<PaginatedFilterParams> = {
  id: "paginated-filter",
  summary: "Paginate a list tool, filter and project items in the sandbox, return count + sample (+ optional group counts).",
  build(p) {
    const ns = ident(p.namespace ?? "codemode", "namespace");
    const tool = ident(p.listTool, "listTool");
    return `async () => {
  const ev = helpers.evidence();
  const all = await helpers.paginate(
    (cursor) => ${ns}.${tool}({ ...${J(p.baseArgs ?? {})}, ...(cursor == null ? {} : { [${J(p.cursorArg ?? "cursor")}]: cursor }) }),
    { items: ${J(p.itemsField ?? "items")}, next: ${J(p.nextField ?? "next")}, maxPages: ${J(p.maxPages ?? 20)} });
  ev.step("paginate", { pages: all.pages, items: all.items.length, truncated: all.truncated });
  const filtered = helpers.where(all.items, ${J(p.where ?? {})});
  ev.step("filter", { kept: filtered.length });
  const fields = ${J(p.fields ?? null)};
  const projected = fields ? helpers.pick(filtered, fields) : filtered;
  const groupBy = ${J(p.groupBy ?? null)};
  return helpers.result(helpers.summarize(projected, { sample: ${J(p.sample ?? 5)} }), { ok: !all.truncated,
    groups: groupBy ? helpers.countBy(filtered, groupBy) : undefined,
    truncated: all.truncated, evidence: ev.steps });
}`;
  },
};

export interface FanOutEnrichParams {
  namespace?: string;
  listTool: string;
  listArgs?: Record<string, unknown>;
  itemsField?: string;
  /** Field of each listed item holding the id. */
  idField: string;
  detailTool: string;
  /** Argument name the detail tool expects for the id. */
  detailArg: string;
  fields?: string[];
  concurrency?: number;
  limit?: number;
}

/** List ids, fetch details in parallel with bounded concurrency, keep partial results. */
export const fanOutEnrich: Recipe<FanOutEnrichParams> = {
  id: "fan-out-enrich",
  summary: "List items, fetch each detail in parallel (bounded), tolerate partial failures, return projected details + errors.",
  build(p) {
    const ns = ident(p.namespace ?? "codemode", "namespace");
    const list = ident(p.listTool, "listTool");
    const detail = ident(p.detailTool, "detailTool");
    return `async () => {
  const ev = helpers.evidence();
  const listed = await ${ns}.${list}(${J(p.listArgs ?? {})});
  const items = (Array.isArray(listed) ? listed : (listed && listed[${J(p.itemsField ?? "items")}]) || []).slice(0, ${J(p.limit ?? 50)});
  ev.step("list", { count: items.length });
  const ids = items.map((it) => it[${J(p.idField)}]);
  const results = await helpers.parallel(ids.map((id) => () => ${ns}.${detail}({ [${J(p.detailArg)}]: id })), { concurrency: ${J(p.concurrency ?? 4)} });
  const { values, errors, complete } = helpers.settle(results);
  ev.step("details", { ok: values.length, failed: errors.length });
  const fields = ${J(p.fields ?? null)};
  return helpers.result(fields ? helpers.pick(values, fields) : values, {
    ok: complete, errors: errors.map((e) => ({ id: ids[e.index], error: e.error })), evidence: ev.steps });
}`;
  },
};

export interface GuardedBulkUpdateParams {
  namespace?: string;
  findTool: string;
  findArgs?: Record<string, unknown>;
  itemsField?: string;
  idField: string;
  updateTool: string;
  idArg: string;
  patch: Record<string, unknown>;
  /** Hard cap on writes. Default 20. */
  maxWrites?: number;
  /** Default true: report what would change without writing. */
  dryRun?: boolean;
}

/** Find targets, then (unless dryRun) apply one write per target sequentially, stopping at the first failure. */
export const guardedBulkUpdate: Recipe<GuardedBulkUpdateParams> = {
  id: "guarded-bulk-update",
  summary: "Find targets, dry-run by default, cap the number of writes, apply sequentially and stop on first error.",
  build(p) {
    const ns = ident(p.namespace ?? "codemode", "namespace");
    const find = ident(p.findTool, "findTool");
    const update = ident(p.updateTool, "updateTool");
    if (Object.hasOwn(p.patch, p.idArg)) throw new Error(`patch must not contain the id argument "${p.idArg}"`);
    if (p.dryRun !== undefined && typeof p.dryRun !== "boolean") throw new Error("dryRun must be a boolean");
    return `async () => {
  const ev = helpers.evidence();
  const found = await ${ns}.${find}(${J(p.findArgs ?? {})});
  const targets = (Array.isArray(found) ? found : (found && found[${J(p.itemsField ?? "items")}]) || []).map((t) => t[${J(p.idField)}]);
  ev.step("find", { targets: targets.length });
  const maxWrites = ${J(p.maxWrites ?? 20)};
  if (targets.length > maxWrites) return helpers.result({ targets }, { ok: false, reason: "too many targets (" + targets.length + " > " + maxWrites + ")", evidence: ev.steps });
  if (${J(p.dryRun ?? true)}) return helpers.result({ wouldUpdate: targets, patch: ${J(p.patch)} }, { dryRun: true, evidence: ev.steps });
  const applied = [];
  for (const id of targets) {
    try {
      await ${ns}.${update}({ ...${J(p.patch)}, [${J(p.idArg)}]: id });
      applied.push(id);
    } catch (e) {
      ev.step("stopped", { id, error: String(e.message || e) });
      return helpers.result({ applied, pending: targets.slice(applied.length) }, { ok: false, evidence: ev.steps });
    }
  }
  ev.step("applied", { count: applied.length });
  return helpers.result({ applied }, { evidence: ev.steps });
}`;
  },
};

export const RECIPES = { paginatedFilter, fanOutEnrich, guardedBulkUpdate };
