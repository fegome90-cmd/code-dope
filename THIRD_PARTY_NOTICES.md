# THIRD_PARTY_NOTICES

## Copied (vendored) code

`src/vendor/cf-normalize.ts`, `src/vendor/cf-json-schema-types.ts` and `src/vendor/cf-utils.ts` are copied from
https://github.com/cloudflare/agents (`packages/codemode/src/normalize.ts`, `json-schema-types.ts`, `utils.ts`),
commit `841b6fc92816d3369dbef7ed3f39168519409248`. The only changes are the header comments and the import paths.
`src/mcp-resources.ts#unwrapMcpResult`, shared by both adapters, follows the same priority order as
`unwrapMcpResult` in `packages/codemode/src/mcp.ts` (rewritten). The `code` tool is registered directly.

License of that code:

```
MIT License Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice
(including the next paragraph) shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Runtime dependencies (not copied)

| Package | Version | License |
|---|---|---|
| `@cloudflare/codemode` | 0.5.6 | MIT |
| `quickjs-emscripten` | 0.32.0 | MIT |
| `acorn` | 8.19.0 | MIT |
| `@cfworker/json-schema` | 4.1.6 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `zod` | 4.6.7 | MIT |

Design ideas (no code copied) were taken from universal-tool-calling-protocol/code-mode (MPL-2.0 / MIT) and Anthropic's public docs.

All installed packages (incl. transitive and dev): MIT 94, ISC 7, BSD-3-Clause 2, BSD-2-Clause 1, Apache-2.0 1 — no copyleft (checked from node_modules manifests, 2026-11-26).
