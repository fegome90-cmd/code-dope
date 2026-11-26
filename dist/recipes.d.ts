export interface Recipe<P> {
    id: string;
    summary: string;
    build(params: P): string;
}
export interface PaginatedFilterParams {
    namespace?: string;
    /** Paginated list tool. Called as tool({ ...baseArgs, [cursorArg]: cursor }). */
    listTool: string;
    baseArgs?: Record<string, unknown>;
    cursorArg?: string;
    itemsField?: string;
    nextField?: string;
    maxPages?: number;
    where?: Record<string, unknown>;
    fields?: string[];
    groupBy?: string;
    sample?: number;
}
/** List everything across pages, filter, project fields, return a compact summary. */
export declare const paginatedFilter: Recipe<PaginatedFilterParams>;
export interface FanOutEnrichParams {
    namespace?: string;
    listTool: string;
    listArgs?: Record<string, unknown>;
    itemsField?: string;
    /** Field of each listed item holding the id. */
    idField: string;
    detailTool: string;
    /** Argument name the detail tool expects for the id. */
    detailArg: string;
    fields?: string[];
    concurrency?: number;
    limit?: number;
}
/** List ids, fetch details in parallel with bounded concurrency, keep partial results. */
export declare const fanOutEnrich: Recipe<FanOutEnrichParams>;
export interface GuardedBulkUpdateParams {
    namespace?: string;
    findTool: string;
    findArgs?: Record<string, unknown>;
    itemsField?: string;
    idField: string;
    updateTool: string;
    idArg: string;
    patch: Record<string, unknown>;
    /** Hard cap on writes. Default 20. */
    maxWrites?: number;
    /** Default true: report what would change without writing. */
    dryRun?: boolean;
}
/** Find targets, then (unless dryRun) apply one write per target sequentially, stopping at the first failure. */
export declare const guardedBulkUpdate: Recipe<GuardedBulkUpdateParams>;
export declare const RECIPES: {
    paginatedFilter: Recipe<PaginatedFilterParams>;
    fanOutEnrich: Recipe<FanOutEnrichParams>;
    guardedBulkUpdate: Recipe<GuardedBulkUpdateParams>;
};
