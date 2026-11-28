"""Run: python3 -m unittest tests/test_ptc_helpers.py  (simulates PTC tools as async str-returning functions)."""
import asyncio, json, sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "snippets"))
from ptc_helpers import as_json, parallel, paginate, retry, pick, where, summarize  # noqa: E402

ORDERS = [{"id": f"o-{i}", "status": ["pending", "shipped"][i % 2], "total": i * 10, "notes": "x" * 100} for i in range(25)]


async def list_orders(params):  # PTC-style tool: dict in, str out
    start = int(params.get("cursor") or 0)
    nxt = str(start + 10) if start + 10 < len(ORDERS) else None
    return json.dumps({"items": ORDERS[start:start + 10], "next": nxt})


async def get_customer(params):
    if params["id"] == "bad":
        raise RuntimeError("unavailable")
    return json.dumps({"id": params["id"], "tier": "gold"})


class PtcHelpersTest(unittest.TestCase):
    def test_pick_preserves_null_and_omits_missing_paths(self):
        value = {"total": None, "nested": {"value": None}, "empty": None}
        self.assertEqual(pick(value, ["total", "missing", "nested.value", "empty.value"]), {"total": None, "nested.value": None})
        self.assertEqual(pick([value, {}], ["total"]), [{"total": None}, {}])

    def test_pagination_stops_before_requesting_a_repeated_cursor(self):
        cursors = []
        async def page(cursor):
            cursors.append(cursor)
            return {"items": [len(cursors)], "next": "a"}
        result = asyncio.run(paginate(page))
        self.assertEqual(cursors, [None, "a"])
        self.assertEqual(result, {"items": [1, 2], "pages": 2, "truncated": True, "stalled": True})
        for terminal in [None, ""]:
            async def last(_cursor):
                return {"items": [7], "next": terminal}
            self.assertEqual(asyncio.run(paginate(last)), {"items": [7], "pages": 1, "truncated": False})

    def test_retry_never_repeats_policy_denials(self):
        attempts = []
        async def denied():
            attempts.append(1)
            raise RuntimeError("Denied read_orders")
        with self.assertRaisesRegex(RuntimeError, "Denied read_orders"):
            asyncio.run(retry(denied, attempts=4))
        self.assertEqual(len(attempts), 1)

    def test_paginate_filter_pick(self):
        async def _run():
            res = await paginate(lambda c: _fetch(c))
            pend = pick(where(res["items"], status="pending"), ["id", "total"])
            return res, summarize(pend, sample=2)

        async def _fetch(c):
            return as_json(await list_orders({} if c is None else {"cursor": c}))

        res, summ = asyncio.run(_run())
        self.assertEqual(res["pages"], 3)
        self.assertFalse(res["truncated"])
        self.assertEqual(summ["count"], 13)
        self.assertEqual(summ["sample"], [{"id": "o-0", "total": 0}, {"id": "o-2", "total": 20}])

    def test_parallel_partial_and_retry(self):
        async def _run():
            rs = await parallel([lambda i=i: get_customer({"id": i}) for i in ["a", "bad", "b"]], concurrency=2)
            n = {"k": 0}

            async def flaky():
                n["k"] += 1
                if n["k"] < 3:
                    raise RuntimeError("transient")
                return "ok"
            return rs, await retry(flaky)

        rs, r = asyncio.run(_run())
        self.assertEqual([x["ok"] for x in rs], [True, False, True])
        self.assertEqual(rs[1]["error"], "unavailable")
        self.assertEqual(r, "ok")


if __name__ == "__main__":
    unittest.main()
