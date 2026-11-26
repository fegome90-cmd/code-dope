/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * Replaces hyphens, dots, and spaces with `_`, strips other invalid chars,
 * prefixes digit-leading names with `_`, and appends `_` to JS reserved words.
 */
export declare function sanitizeToolName(name: string): string;
export declare function toPascalCase(str: string): string;
/**
 * Quote a property name if needed.
 * Escapes backslashes, quotes, and control characters.
 */
export declare function quoteProp(name: string): string;
/**
 * Escape a string for use inside a double-quoted TypeScript string literal.
 */
export declare function escapeStringLiteral(s: string): string;
/**
 * Escape a string for use inside a JSDoc comment.
 * Prevents premature comment closure from star-slash sequences.
 */
export declare function escapeJsDoc(text: string): string;
