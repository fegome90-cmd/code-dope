// Vendored from cloudflare/agents packages/codemode/src/normalize.ts @ 841b6fc (MIT, (c) 2025 Cloudflare, Inc.).
// Local changes: linear fence stripping and arrow-expression slicing. See THIRD_PARTY_NOTICES.md.
import * as acorn from "acorn";
const fenceTags = new Set(["", "js", "javascript", "typescript", "ts", "tsx", "jsx"]);
/**
 * Strip markdown code fences that LLMs commonly wrap code in.
 * Handles ```js, ```javascript, ```typescript, ```ts, or bare ```.
 */
function stripCodeFences(raw) {
    const trimmed = raw.trimEnd();
    if (!trimmed.startsWith("```"))
        return raw;
    const nl = trimmed.indexOf("\n");
    if (nl === -1 || !fenceTags.has(trimmed.slice(3, nl).trim()))
        return raw;
    const closeIdx = trimmed.length - 3;
    if (closeIdx <= nl || !trimmed.endsWith("```"))
        return raw;
    let closeLine = closeIdx;
    while (trimmed[closeLine - 1] === " " || trimmed[closeLine - 1] === "\t") {
        closeLine--;
    }
    if (trimmed[closeLine - 1] !== "\n")
        return raw;
    let bodyEnd = closeLine - 1;
    if (trimmed[bodyEnd - 1] === "\r")
        bodyEnd--;
    return trimmed.slice(nl + 1, bodyEnd);
}
export function normalizeCode(code) {
    const trimmed = stripCodeFences(code.trim());
    if (!trimmed.trim())
        return "async () => {}";
    const source = trimmed.trim();
    try {
        const ast = acorn.parse(source, {
            ecmaVersion: "latest",
            sourceType: "module"
        });
        // Keep the arrow expression, not statement punctuation around it.
        if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
            const expr = ast.body[0].expression;
            if (expr.type === "ArrowFunctionExpression")
                return source.slice(expr.start, expr.end);
        }
        // export default <expression> → unwrap to just the expression
        if (ast.body.length === 1 &&
            ast.body[0].type === "ExportDefaultDeclaration") {
            const decl = ast.body[0].declaration;
            const inner = source.slice(decl.start, decl.end);
            // Anonymous function/class declarations aren't valid as standalone
            // statements — wrap them as expressions directly.
            if (decl.type === "FunctionDeclaration" &&
                !decl.id) {
                return `async () => {\nreturn (${inner})();\n}`;
            }
            if (decl.type === "ClassDeclaration" &&
                !decl.id) {
                return `async () => {\nreturn (${inner});\n}`;
            }
            return normalizeCode(inner);
        }
        // Single named function declaration → wrap and call it
        if (ast.body.length === 1 && ast.body[0].type === "FunctionDeclaration") {
            const fn = ast.body[0];
            const name = fn.id?.name ?? "fn";
            return `async () => {\n${source}\nreturn ${name}();\n}`;
        }
        // Last statement is expression → splice in return
        const last = ast.body[ast.body.length - 1];
        if (last?.type === "ExpressionStatement") {
            const exprStmt = last;
            const before = source.slice(0, last.start);
            const exprText = source.slice(exprStmt.expression.start, exprStmt.expression.end);
            return `async () => {\n${before}return (${exprText})\n}`;
        }
        return `async () => {\n${source}\n}`;
    }
    catch {
        return `async () => {\n${source}\n}`;
    }
}
