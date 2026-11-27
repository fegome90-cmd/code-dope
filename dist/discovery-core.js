import { generateTypesFromJsonSchema, jsonSchemaToType } from "./vendor/cf-json-schema-types.js";
import { sanitizeToolName, escapeJsDoc } from "./vendor/cf-utils.js";
import { collisions } from "./policy.js";
const tokens = (s) => s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
/** A query word matches a tool word exactly, or as a prefix of 3+ chars ("order" ~ "orders"). */
const hit = (words, w) => words.some((x) => x === w || (w.length >= 3 && (x.startsWith(w) || w.startsWith(x)) && x.length >= 3));
/** Rank tools by word overlap with the query (name weighted 3x description). Empty query → no results. */
export function searchTools(catalog, query, limit = 5) {
    const q = [...new Set(tokens(query))];
    if (q.length === 0)
        return [];
    return catalog
        .map((t) => {
        const name = tokens(t.name);
        const desc = tokens(t.description ?? "");
        const score = q.reduce((s, w) => s + (hit(name, w) ? 3 : 0) + (hit(desc, w) ? 1 : 0), 0);
        return { t, score };
    })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
        .slice(0, limit)
        .map((x) => x.t);
}
/** TypeScript declarations for a subset of tools (Cloudflare generator, vendored). */
export function typesFor(tools, ambiguous = collisions(tools.map((t) => t.name))) {
    if (tools.some((t) => ambiguous.has(t.name))) {
        // Unique type names and quoted properties keep exact tool names distinct.
        const declarations = [];
        const methods = tools.map((t, i) => {
            const input = `Tool${i}Input`;
            try {
                declarations.push(jsonSchemaToType((t.inputSchema ?? { type: "object" }), input));
            }
            catch {
                declarations.push(`type ${input} = unknown`);
            }
            const name = ambiguous.has(t.name) ? t.name : sanitizeToolName(t.name);
            const doc = t.description ? `\n\t/** ${escapeJsDoc(t.description.replace(/\r?\n/g, " "))} */` : "";
            return `${doc}\n\t${JSON.stringify(name)}: (input: ${input}) => Promise<unknown>;`;
        });
        return `${declarations.join("\n")}\ndeclare const codemode: {${methods.join("")}\n}`;
    }
    return generateTypesFromJsonSchema(Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: (t.inputSchema ?? { type: "object" }) }])));
}
