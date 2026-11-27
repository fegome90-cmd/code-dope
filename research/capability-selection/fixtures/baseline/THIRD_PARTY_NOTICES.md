# Offline fixture provenance

The two original source files `policy.ts` and `vendor/cf-utils.ts` are exact Git blobs from `fegome90-cmd/code-dope@0bd8cbc8ed278ad93ac7f5d69c0ccc4cf932b71a`. `direct.ts` is new candidate glue, not an original file. The copied Cloudflare utility is retained under its original MIT notice; no new Cloudflare, UTCP, OpenCode or QuickJS runtime is vendored in this fixture.

`vendor/cf-utils.ts`: Cloudflare Agents `packages/codemode/src/utils.ts` at commit `841b6fc92816d3369dbef7ed3f39168519409248` as vendored in the Code Dope baseline. The baseline notice records only header/import-path changes for the vendored modules.

MIT License Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The separate `../upstream/executor-types.ts` fixture is the exact Cloudflare source blob `a087d0a0200d7bcbc19fe16e74d56d6c995aeb9b` at the same pinned commit. It is used for contract-only TypeScript compilation and is covered by the Cloudflare MIT notice above.
