/**
 * Example plugin: a "notes insights" plugin whose host loads `plugin.tools`
 * and calls `handler(input)`. The plugin already owns its tool functions
 * (in-process, no MCP), and adds ONE Code Mode tool built from the library.
 * Nothing here re-implements sandboxing, policy, helpers or recipes.
 */
import { createCodeRunner, HELPERS_DOC, RECIPES, typesFor } from "../../src/index.ts";

// --- the plugin's own (synthetic) data and tools ---------------------------
const NOTES = Array.from({ length: 30 }, (_, i) => ({
  id: `n-${i + 1}`,
  tag: ["work", "home", "ideas"][i % 3],
  pinned: i % 5 === 0,
  text: `Note ${i + 1} `.padEnd(400, "."),
}));
const archived: string[] = [];

const notesTools = {
  list_notes: async (a: unknown) => {
    const { offset = 0 } = (a ?? {}) as { offset?: number };
    const items = NOTES.slice(offset, offset + 8);
    return { items, next: offset + 8 < NOTES.length ? offset + 8 : null };
  },
  get_note: async (a: unknown) => NOTES.find((n) => n.id === (a as { id: string }).id) ?? Promise.reject(new Error("not found")),
  archive_note: async (a: unknown) => { archived.push((a as { id: string }).id); return { ok: true }; },
};

const toolEntries = [
  { name: "list_notes", description: "List notes, 8 per page; pass offset=next.", inputSchema: { type: "object", properties: { offset: { type: "number" } } } },
  { name: "get_note", description: "Get one note.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "archive_note", description: "Archive a note (side effect).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

// --- Code Mode wiring: ~15 lines --------------------------------------------
export function createPlugin(opts: { approveWrites: (tool: string, args: unknown) => boolean }) {
  const runner = createCodeRunner({
    tools: { notes: notesTools },
    policy: {
      read: ["list_notes", "get_note"],
      write: ["archive_note"],
      approve: ({ tool, args }) => opts.approveWrites(tool, args),
      maxCalls: 40,
    },
    executor: { timeoutMs: 10_000 },
  });
  return {
    name: "notes-insights",
    archived,
    tools: [
      {
        name: "notes_code",
        description: `Run JavaScript over the notes tools (namespace \`notes\`).\n${typesFor(toolEntries).replaceAll("codemode", "notes")}\n${HELPERS_DOC}`,
        inputSchema: { type: "object", properties: { code: { type: "string" }, recipe: { type: "string" }, params: { type: "object" } } },
        /** Accepts either model-written code or a library recipe id + params. */
        async handler(input: { code?: string; recipe?: keyof typeof RECIPES; params?: Record<string, unknown> }) {
          const code = input.code ?? (RECIPES[input.recipe!] as { build(p: unknown): string }).build({ namespace: "notes", ...input.params });
          const r = await runner.run(code);
          return r.error ? { isError: true, text: r.error, audit: r.audit } : { isError: false, text: JSON.stringify(r.result), audit: r.audit };
        },
      },
    ],
  };
}
