import { sanitizeToolName, toPascalCase, escapeJsDoc, escapeStringLiteral, quoteProp } from "./cf-utils.js";
const maxNodes = 5_000;
const maxWork = 50_000;
const maxOutput = 1_000_000;
const conversionLimit = Symbol("schema conversion limit");
function spend(budget, amount) {
    budget.remaining -= amount;
    if (budget.remaining < 0)
        throw conversionLimit;
}
/**
 * Resolve an internal JSON Pointer $ref (e.g. #/definitions/Foo) against the root schema.
 * Returns null for external URLs or unresolvable paths.
 */
function resolveRef(ref, root) {
    // "#" is a valid self-reference to the root schema
    if (ref === "#")
        return root;
    if (!ref.startsWith("#/"))
        return null;
    const segments = ref
        .slice(2)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let current = root;
    for (const seg of segments) {
        if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, seg))
            return null;
        current = current[seg];
        if (current === undefined)
            return null;
    }
    // Allow both object schemas and boolean schemas (true = any, false = never)
    if (typeof current === "boolean")
        return current;
    if (current === null || typeof current !== "object" || Array.isArray(current))
        return null;
    return current;
}
/**
 * Apply OpenAPI 3.0 `nullable: true` to a type result.
 */
function applyNullable(result, schema) {
    if (result !== "unknown" &&
        result !== "never" &&
        schema?.nullable === true) {
        return `${result} | null`;
    }
    return result;
}
/**
 * Report whether a generated type has a `|` outside brackets, strings and
 * comments. Such a type needs parentheses inside an intersection.
 */
function hasTopLevelUnion(type) {
    let depth = 0;
    for (let i = 0; i < type.length; i++) {
        const ch = type[i];
        if (ch === '"') {
            for (i++; i < type.length && type[i] !== '"'; i++) {
                if (type[i] === "\\")
                    i++;
            }
        }
        else if (ch === "/" && type[i + 1] === "*") {
            const end = type.indexOf("*/", i + 2);
            if (end === -1)
                return false;
            i = end + 1;
        }
        else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") {
            depth++;
        }
        else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") {
            depth--;
        }
        else if (ch === "|" && depth === 0) {
            return true;
        }
    }
    return false;
}
/**
 * Convert the array keywords of a schema. Does not apply `nullable`.
 */
function arrayTypeString(schema, indent, ctx) {
    // Tuple support: prefixItems (JSON Schema 2020-12)
    const prefixItems = schema
        .prefixItems;
    if (Array.isArray(prefixItems)) {
        spend(ctx.work, prefixItems.length);
        const types = prefixItems.map((s) => renderSchema(s, indent, ctx));
        return `[${types.join(", ")}]`;
    }
    // Tuple support: items as array (draft-07)
    if (Array.isArray(schema.items)) {
        spend(ctx.work, schema.items.length);
        const types = schema.items.map((s) => renderSchema(s, indent, ctx));
        return `[${types.join(", ")}]`;
    }
    if (schema.items || schema.items === false) {
        // Array<T>, not T[]: `[]` binds tighter than `|` and `&`, so a union or
        // intersection item type would otherwise leak out of the array.
        return `Array<${renderSchema(schema.items, indent, ctx)}>`;
    }
    return "unknown[]";
}
/**
 * Convert the object keywords of a schema. Does not apply `nullable`.
 */
function objectTypeString(schema, indent, nextCtx) {
    const props = schema.properties || {};
    const requiredNames = Array.isArray(schema.required) ? schema.required : [];
    spend(nextCtx.work, requiredNames.length);
    const required = new Set(requiredNames);
    const lines = [];
    for (const propName in props) {
        spend(nextCtx.work, 1);
        if (!Object.hasOwn(props, propName))
            continue;
        spend(nextCtx.output, propName.length);
        const propSchema = props[propName];
        const isRequired = required.has(propName);
        const propType = renderSchema(propSchema, indent + "    ", nextCtx);
        const property = propSchema && typeof propSchema === "object" ? propSchema : undefined;
        const desc = typeof property?.description === "string" ? property.description : "";
        const format = typeof property?.format === "string" ? property.format : "";
        if (desc || format) {
            spend(nextCtx.output, desc.length + format.length);
            const descText = desc
                ? escapeJsDoc(desc.replace(/\r?\n/g, " "))
                : undefined;
            const formatTag = format ? `@format ${escapeJsDoc(format)}` : undefined;
            if (descText && formatTag) {
                lines.push(`${indent}    /**`);
                lines.push(`${indent}     * ${descText}`);
                lines.push(`${indent}     * ${formatTag}`);
                lines.push(`${indent}     */`);
            }
            else {
                lines.push(`${indent}    /** ${descText ?? formatTag} */`);
            }
        }
        const quotedName = quoteProp(propName);
        const optionalMark = isRequired ? "" : "?";
        lines.push(`${indent}    ${quotedName}${optionalMark}: ${propType};`);
    }
    // Handle additionalProperties
    if (schema.additionalProperties) {
        const valueType = schema.additionalProperties === true
            ? "unknown"
            : renderSchema(schema.additionalProperties, indent + "    ", nextCtx);
        lines.push(`${indent}    [key: string]: ${valueType};`);
    }
    if (lines.length === 0) {
        if (schema.additionalProperties === false) {
            return "{}";
        }
        return "Record<string, unknown>";
    }
    return `{\n${lines.join("\n")}\n${indent}}`;
}
/**
 * Convert a schema as if its `type` were the single type `type`.
 * Does not apply `nullable`.
 */
function singleTypeString(type, schema, indent, ctx) {
    if (type === "string")
        return "string";
    if (type === "number" || type === "integer")
        return "number";
    if (type === "boolean")
        return "boolean";
    if (type === "null")
        return "null";
    if (type === "array")
        return arrayTypeString(schema, indent, ctx);
    if (type === "object" || schema.properties) {
        return objectTypeString(schema, indent, ctx);
    }
    return "unknown";
}
/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
export function jsonSchemaToTypeString(schema, indent, ctx) {
    const active = {
        ...ctx,
        budget: ctx.budget ?? { remaining: maxNodes },
        work: ctx.work ?? { remaining: maxWork },
        output: ctx.output ?? { remaining: maxOutput },
        memo: ctx.memo ?? new Map(),
        unsafe: ctx.unsafe ?? { count: 0 }
    };
    try {
        return renderSchema(schema, indent, active);
    }
    catch (error) {
        if (error !== conversionLimit)
            throw error;
        return "unknown";
    }
}
function accountOutput(text, ctx) {
    spend(ctx.output, text.length);
    return text;
}
function renderSchema(schema, indent, ctx) {
    // Boolean schemas are types, not object visits.
    if (typeof schema === "boolean")
        return accountOutput(schema ? "unknown" : "never", ctx);
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return accountOutput("unknown", ctx);
    }
    spend(ctx.work, 1);
    if (ctx.depth >= ctx.maxDepth || ctx.seen.has(schema)) {
        ctx.unsafe.count++;
        return accountOutput("unknown", ctx);
    }
    // The available depth is path-dependent; siblings at the same depth can share
    // complete results. Every occurrence still spends text budget, even on a hit.
    const key = `${ctx.depth}:${indent}`;
    const cached = ctx.memo.get(schema)?.get(key);
    if (cached !== undefined)
        return accountOutput(cached, ctx);
    if (--ctx.budget.remaining < 0) {
        ctx.unsafe.count++;
        return accountOutput("unknown", ctx);
    }
    const unsafeBefore = ctx.unsafe.count;
    ctx.seen.add(schema);
    try {
        const out = accountOutput(renderType(schema, indent, { ...ctx, depth: ctx.depth + 1 }), ctx);
        if (ctx.unsafe.count === unsafeBefore) {
            const entries = ctx.memo.get(schema) ?? new Map();
            entries.set(key, out);
            ctx.memo.set(schema, entries);
        }
        return out;
    }
    finally {
        ctx.seen.delete(schema);
    }
}
function literalType(value, ctx) {
    if (value === null)
        return "null";
    if (typeof value === "string") {
        spend(ctx.output, value.length);
        return '"' + escapeStringLiteral(value) + '"';
    }
    if (typeof value === "object") {
        return JSON.stringify(value, (key, child) => {
            spend(ctx.work, 1);
            spend(ctx.output, key.length + (typeof child === "string" ? child.length : 0));
            return child;
        }) ?? "unknown";
    }
    return String(value);
}
function renderType(schema, indent, nextCtx) {
    if (typeof schema.$ref === "string" && schema.$ref) {
        spend(nextCtx.work, schema.$ref.length);
        const resolved = resolveRef(schema.$ref, nextCtx.root);
        if (resolved === null)
            return "unknown";
        return applyNullable(renderSchema(resolved, indent, nextCtx), schema);
    }
    // Union keywords take precedence in the same order as upstream.
    const variants = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
    if (Array.isArray(variants)) {
        spend(nextCtx.work, variants.length);
        if (variants.length === 0)
            return "never";
        const types = variants.map((s) => renderSchema(s, indent, nextCtx));
        return applyNullable(types.join(" | "), schema);
    }
    if (Array.isArray(schema.allOf)) {
        spend(nextCtx.work, schema.allOf.length);
        if (schema.allOf.length === 0)
            return "unknown";
        // `&` binds tighter than `|`, so a union member needs parentheses.
        const types = schema.allOf.map((s) => {
            const member = renderSchema(s, indent, nextCtx);
            return hasTopLevelUnion(member) ? `(${member})` : member;
        });
        return applyNullable(types.join(" & "), schema);
    }
    if (Array.isArray(schema.enum)) {
        spend(nextCtx.work, schema.enum.length);
        if (schema.enum.length === 0)
            return "never";
        const types = schema.enum.map((v) => accountOutput(literalType(v, nextCtx), nextCtx));
        return applyNullable(types.join(" | "), schema);
    }
    if (schema.const !== undefined)
        return applyNullable(literalType(schema.const, nextCtx), schema);
    const type = schema.type;
    // Each member of a type array reads the schema's own keywords.
    if (Array.isArray(type)) {
        spend(nextCtx.work, type.length);
        const types = new Set(type.map((t) => accountOutput(singleTypeString(t, schema, indent, nextCtx), nextCtx)));
        if (types.size === 0 || types.has("unknown"))
            return "unknown";
        return applyNullable([...types].join(" | "), schema);
    }
    if (type === "null")
        return "null";
    return applyNullable(singleTypeString(type, schema, indent, nextCtx), schema);
}
/**
 * Convert a JSON Schema to a TypeScript type declaration.
 */
export function jsonSchemaToType(schema, typeName) {
    const ctx = {
        root: schema,
        depth: 0,
        seen: new Set(),
        maxDepth: 20
    };
    const typeBody = jsonSchemaToTypeString(schema, "", ctx);
    return `type ${typeName} = ${typeBody}`;
}
/**
 * Extract field descriptions from a JSON Schema's properties.
 */
function extractJsonSchemaDescriptions(schema) {
    const descriptions = Object.create(null);
    const work = { remaining: maxWork };
    const output = { remaining: maxOutput };
    if (!schema.properties)
        return descriptions;
    for (const fieldName in schema.properties) {
        spend(work, 1);
        if (!Object.hasOwn(schema.properties, fieldName))
            continue;
        const propSchema = schema.properties[fieldName];
        if (propSchema && typeof propSchema === "object" && typeof propSchema.description === "string" && propSchema.description) {
            spend(output, fieldName.length + propSchema.description.length);
            descriptions[fieldName] = propSchema.description;
        }
    }
    return descriptions;
}
/**
 * Generate TypeScript type definitions from tool descriptors with JSON Schema.
 * This function has NO dependency on the AI SDK or Zod — it works purely with
 * JSON Schema objects.
 *
 * Use this when you have raw JSON Schema (e.g. from OpenAPI specs, MCP tool
 * definitions, etc.) and don't need the AI SDK.
 */
export function generateTypesFromJsonSchema(tools) {
    let availableTools = "";
    let availableTypes = "";
    for (const [toolName, tool] of Object.entries(tools)) {
        const safeName = sanitizeToolName(toolName);
        const typeName = toPascalCase(safeName);
        try {
            const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);
            const outputType = tool.outputSchema
                ? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
                : `type ${typeName}Output = unknown`;
            availableTypes += `\n${inputType.trim()}`;
            availableTypes += `\n${outputType.trim()}`;
            const paramLines = (() => {
                try {
                    const paramDescs = extractJsonSchemaDescriptions(tool.inputSchema);
                    return Object.entries(paramDescs).map(([fieldName, desc]) => `@param input.${fieldName} - ${desc}`);
                }
                catch {
                    return [];
                }
            })();
            const jsdocLines = [];
            if (tool.description?.trim()) {
                jsdocLines.push(escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " ")));
            }
            else {
                jsdocLines.push(escapeJsDoc(toolName));
            }
            for (const pd of paramLines) {
                jsdocLines.push(escapeJsDoc(pd.replace(/\r?\n/g, " ")));
            }
            const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
            availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
            availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
            availableTools += "\n";
        }
        catch {
            availableTypes += `\ntype ${typeName}Input = unknown`;
            availableTypes += `\ntype ${typeName}Output = unknown`;
            availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
            availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
            availableTools += "\n";
        }
    }
    availableTools = `\ndeclare const codemode: {${availableTools}}`;
    return `
${availableTypes}
${availableTools}
  `.trim();
}
