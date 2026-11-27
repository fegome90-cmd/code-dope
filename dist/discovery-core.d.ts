export interface ToolEntry {
    name: string;
    description?: string;
    inputSchema?: unknown;
}
/** Rank tools by word overlap with the query (name weighted 3x description). Empty query → no results. */
export declare function searchTools(catalog: ToolEntry[], query: string, limit?: number): ToolEntry[];
/** TypeScript declarations for a subset of tools (Cloudflare generator, vendored). */
export declare function typesFor(tools: ToolEntry[], ambiguous?: Set<string>): string;
