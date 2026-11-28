"""code-dope helpers for Claude Programmatic Tool Calling (code_execution_20260120+).

Paste at the top of a PTC code cell. In PTC, each allowed tool is an async
function taking one dict and returning a string (usually JSON). Standard
library only. Mirrors src/sandbox/helpers.js (parallel, paginate, pick, where,
summarize, retry) so recipes translate 1:1.
"""
import asyncio, json


def as_json(text):
    """Tool results arrive as strings; parse JSON when possible."""
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


async def parallel(thunks, concurrency=4):
    """Run zero-arg coroutine factories with bounded concurrency. Never raises: [{'ok':..}]."""
    sem = asyncio.Semaphore(max(1, concurrency))

    async def one(t):
        async with sem:
            try:
                return {"ok": True, "value": await t()}
            except Exception as e:  # noqa: BLE001 - partial results by design
                return {"ok": False, "error": str(e)}

    return await asyncio.gather(*(one(t) for t in thunks))


async def paginate(fetch_page, items="items", next_key="next", max_pages=20):
    """fetch_page(cursor|None) -> parsed page dict. Returns {'items', 'pages', 'truncated'}."""
    out, cursor = [], None
    for pages in range(1, max_pages + 1):
        page = await fetch_page(cursor)
        out.extend((page or {}).get(items) or [])
        next_cursor = (page or {}).get(next_key)
        if next_cursor in (None, ""):
            return {"items": out, "pages": pages, "truncated": False}
        if next_cursor == cursor:
            return {"items": out, "pages": pages, "truncated": True, "stalled": True}
        cursor = next_cursor
    return {"items": out, "pages": max_pages, "truncated": True}


async def retry(fn, attempts=3):
    """Retry idempotent (read) calls only."""
    last = None
    for _ in range(max(1, attempts)):
        try:
            return await fn()
        except Exception as e:  # noqa: BLE001
            if str(e).startswith("Denied "):
                raise
            last = e
    raise last


def pick(value, fields):
    missing = object()
    def one(o):
        r = {}
        for f in fields:
            v = o
            for part in f.split("."):
                v = v.get(part, missing) if isinstance(v, dict) else missing
            if v is not missing:
                r[f] = v
        return r
    return [one(o) for o in value] if isinstance(value, list) else one(value)


def where(items, **criteria):
    def ok(it):
        for k, c in criteria.items():
            v = it.get(k)
            if callable(c):
                if not c(v):
                    return False
            elif isinstance(c, (list, tuple, set)):
                if v not in c:
                    return False
            elif v != c:
                return False
        return True
    return [it for it in items if ok(it)]


def summarize(items, sample=3):
    return {"count": len(items), "sample": items[:sample], "omitted": max(0, len(items) - sample)}
