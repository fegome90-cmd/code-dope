/** Simulated plugin host: load the plugin, call its Code Mode tool twice (recipe + custom code). */
import { createPlugin } from "./plugin.ts";

const plugin = createPlugin({ approveWrites: (_tool, args) => (args as { id: string }).id !== "n-1" });
const tool = plugin.tools[0];

const viaRecipe = await tool.handler({
  recipe: "paginatedFilter",
  params: { listTool: "list_notes", cursorArg: "offset", where: { tag: "ideas" }, fields: ["id", "pinned"], groupBy: "pinned", sample: 3 },
});
console.log("recipe paginatedFilter →", viaRecipe.text);
console.log("  tool calls:", viaRecipe.audit.length);

const custom = await tool.handler({
  code: `async () => {
    const all = await helpers.paginate((c) => notes.list_notes(c == null ? {} : { offset: c }));
    const pinned = helpers.where(all.items, { pinned: true }).map((n) => n.id);
    const res = helpers.settle(await helpers.parallel(pinned.map((id) => () => notes.archive_note({ id }))));
    return { pinned, archived: res.values.length, denied: res.errors.map((e) => pinned[e.index]) };
  }`,
});
console.log("custom code →", custom.text);
console.log("  archived in store:", plugin.archived.join(","));
console.log("  audit:", custom.audit.map((a) => `${a.tool}:${a.decision}`).join(" "));
