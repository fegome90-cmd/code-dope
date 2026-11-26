// code-dope sandbox helpers — plain ES2020, no imports, no timers, no I/O.
// Runs inside any Code Mode sandbox (QuickJSExecutor, Cloudflare Dynamic
// Workers, browser iframe) or can be pasted into a native Code Mode host.
// Defines `globalThis.helpers`. Every function is pure orchestration over
// async tool calls supplied by the caller.
globalThis.helpers = (() => {
  /** Run thunks with bounded concurrency. Never rejects: returns [{ok, value} | {ok:false, error}]. */
  async function parallel(thunks, opts = {}) {
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const out = new Array(thunks.length);
    let next = 0;
    async function worker() {
      while (next < thunks.length) {
        const i = next++;
        try {
          out[i] = { ok: true, value: await thunks[i]() };
        } catch (e) {
          out[i] = { ok: false, error: String((e && e.message) || e) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, thunks.length) }, worker));
    return out;
  }

  /** Split parallel() results into values and errors (partial-result handling). */
  function settle(results) {
    const values = [], errors = [];
    results.forEach((r, index) => (r.ok ? values.push(r.value) : errors.push({ index, error: r.error })));
    return { values, errors, complete: errors.length === 0 };
  }

  /**
   * Cursor pagination. fetchPage(cursor) must resolve to a page object.
   * opts.items / opts.next: field names (default "items" / "next").
   */
  async function paginate(fetchPage, opts = {}) {
    const itemsKey = opts.items ?? "items", nextKey = opts.next ?? "next";
    const maxPages = opts.maxPages ?? 20;
    const items = [];
    let cursor = opts.start ?? null, pages = 0;
    while (pages < maxPages) {
      const page = await fetchPage(cursor);
      pages++;
      const batch = (page && page[itemsKey]) || [];
      for (const it of batch) items.push(it);
      const next = page ? page[nextKey] : null;
      if (next === null || next === undefined || next === "") return { items, pages, truncated: false };
      if (next === cursor) return { items, pages, truncated: true, stalled: true }; // server returned the same cursor
      cursor = next;
    }
    return { items, pages, truncated: true };
  }

  /** Process items in chunks of `size` sequentially; fn(chunk, index) per chunk. */
  async function batch(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(await fn(items.slice(i, i + size), i / size));
    return out;
  }

  /** Retry ONLY idempotent (read) calls. No backoff: sandboxes have no timers. Policy denials are never retried. */
  async function retry(fn, opts = {}) {
    const attempts = Math.max(1, opts.attempts ?? 3);
    const isDenial = (e) => /^Denied /.test(String((e && e.message) || e));
    const retryIf = opts.retryIf ?? ((e) => !isDenial(e));
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn(i);
      } catch (e) {
        last = e;
        if (!retryIf(e)) break;
      }
    }
    throw last;
  }

  /** Keep only selected fields (supports dotted paths). Works on objects or arrays. */
  function pick(value, fields) {
    const one = (o) => {
      const r = {};
      for (const f of fields) {
        let v = o;
        for (const part of f.split(".")) v = v == null ? undefined : v[part];
        if (v !== undefined) r[f] = v;
      }
      return r;
    };
    return Array.isArray(value) ? value.map(one) : one(value);
  }

  /** Declarative filter: where = { field: value | [values] | (v) => bool }. */
  function where(items, criteria) {
    return items.filter((it) =>
      Object.entries(criteria).every(([k, c]) => {
        const v = it[k];
        if (typeof c === "function") return c(v);
        if (Array.isArray(c)) return c.includes(v);
        return v === c;
      }),
    );
  }

  /** Compact view for the model: count + small sample instead of the full payload. */
  function summarize(items, opts = {}) {
    const sample = opts.sample ?? 3;
    return { count: items.length, sample: items.slice(0, sample), omitted: Math.max(0, items.length - sample) };
  }

  /** Group and count by a field. */
  function countBy(items, field) {
    const r = {};
    for (const it of items) {
      const k = String(it[field]);
      r[k] = (r[k] || 0) + 1;
    }
    return r;
  }

  /** Validate required fields before calling a tool; throws a clear error. */
  function requireFields(obj, fields) {
    const missing = fields.filter((f) => obj == null || obj[f] === undefined || obj[f] === null || obj[f] === "");
    if (missing.length) throw new Error("Missing required fields: " + missing.join(", "));
    return obj;
  }

  /** Evidence log returned alongside results so the caller can audit what happened. */
  function evidence() {
    const steps = [];
    return {
      step(label, data) {
        steps.push({ label, ...(data === undefined ? {} : { data }) });
        return data;
      },
      steps,
    };
  }

  /** Structured envelope for final results. */
  function result(data, extra = {}) {
    return { ok: extra.ok ?? true, data, ...extra };
  }

  return { parallel, settle, paginate, batch, retry, pick, where, summarize, countBy, requireFields, evidence, result };
})();
