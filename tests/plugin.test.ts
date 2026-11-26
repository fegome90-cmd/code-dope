import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlugin } from "../examples/plugin-consumer/plugin.ts";

test("plugin consumer: recipe and custom code through the plugin's Code Mode tool", async () => {
  const plugin = createPlugin({ approveWrites: (_t, a) => (a as { id: string }).id !== "n-1" });
  const [tool] = plugin.tools;
  assert.match(tool.description, /notes: \{/);
  const r = await tool.handler({ recipe: "paginatedFilter", params: { listTool: "list_notes", cursorArg: "offset", where: { tag: "ideas" }, fields: ["id"] } });
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.text).data.count, 10);
  const c = await tool.handler({ code: `async () => { const p = await helpers.paginate((c) => notes.list_notes(c == null ? {} : { offset: c })); const ids = helpers.where(p.items, { pinned: true }).map((n) => n.id); return helpers.settle(await helpers.parallel(ids.map((id) => () => notes.archive_note({ id })))).errors.length; }` });
  assert.equal(c.text, "1");
  assert.deepEqual(plugin.archived, ["n-6", "n-11", "n-16", "n-21", "n-26"]);
  assert.ok(c.audit.some((a) => a.tool === "archive_note" && a.decision === "denied"));
});
