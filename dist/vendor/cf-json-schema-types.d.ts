import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
export interface ConversionContext {
    root: JSONSchema7;
    depth: number;
    seen: Set<unknown>;
    maxDepth: number;
    budget?: Budget;
    work?: Budget;
    output?: Budget;
    memo?: Map<object, Map<string, string>>;
    unsafe?: {
        count: number;
    };
}
type Budget = {
    remaining: number;
};
/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
export declare function jsonSchemaToTypeString(schema: JSONSchema7Definition, indent: string, ctx: ConversionContext): string;
/**
 * Convert a JSON Schema to a TypeScript type declaration.
 */
export declare function jsonSchemaToType(schema: JSONSchema7, typeName: string): string;
/**
 * A tool descriptor using plain JSON Schema (no Zod or AI SDK dependency).
 */
export interface JsonSchemaToolDescriptor {
    description?: string;
    inputSchema: JSONSchema7;
    outputSchema?: JSONSchema7;
}
export type JsonSchemaToolDescriptors = Record<string, JsonSchemaToolDescriptor>;
/**
 * Generate TypeScript type definitions from tool descriptors with JSON Schema.
 * This function has NO dependency on the AI SDK or Zod — it works purely with
 * JSON Schema objects.
 *
 * Use this when you have raw JSON Schema (e.g. from OpenAPI specs, MCP tool
 * definitions, etc.) and don't need the AI SDK.
 */
export declare function generateTypesFromJsonSchema(tools: JsonSchemaToolDescriptors): string;
export {};
