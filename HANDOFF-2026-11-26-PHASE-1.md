# HANDOFF — code-dope — Fase 1 (biblioteca v0.1.0)

Fecha: 2026-11-26 · Rama: `feat/code-mode-library` · Commit: `cb97cde` · PR: https://github.com/fegome90-cmd/code-dope/pull/2 (abierto, sin mergear)

## Estado
DONE. El ancla "Code Mode Reusable Library" completa: resultado PASS, con métricas NOT_VERIFIED declaradas. No existe PLAN.md porque el encargo se ejecutó como un solo bloque; si sigues por fases, créalo en la Fase 2.

## Qué se construyó
- **Nivel 3, sandbox Node:** `WorkerExecutor` (default: un worker thread nuevo por ejecución, `env` vacío, heap limitado, kill duro) envuelve a `QuickJSExecutor` (QuickJS-WASM). Ambos implementan el contrato `Executor` de `@cloudflare/codemode`.
- **Nivel 2:**
  - `withPolicy`: fail-closed, read/write, aprobación por llamada, validación, presupuesto, timeout por llamada, auditoría.
  - `createCodeModeMcpServer`: reutiliza `codeMcpServer` de Cloudflare.
  - `createSearchExecuteMcpServer`: descubrimiento progresivo.
  - `createCodeRunner`: para plugins.
  - 3 recipes.
- **Nivel 1:** `src/sandbox/helpers.js` (JS puro, 12 helpers) y `snippets/ptc_helpers.py` (Claude PTC).
- **Catálogo para agentes:** `catalog/patterns.json` (15 patrones).
- **Ejemplos:** servidor MCP stdio, cliente MCP, plugin consumidor.
- **Benchmark:** `bench/run.ts` → `bench/RESULTS.json`.

## Decisiones (detalle en ARCHITECTURE.md y RESEARCH.md)
1. Se reutiliza `@cloudflare/codemode/mcp` como dependencia. Su entry raíz no carga en Node; `./mcp` sí (reproducido).
2. El sandbox es propio porque Cloudflare no trae executor para Node.
3. QuickJS en vez de isolated-vm: es WASM, sin módulo nativo ni APIs de Node.
4. UTCP se descartó como dependencia: su servidor MCP permite ejecución en el host vía `register_manual`, el Python no aísla nada y la licencia es MPL.
5. La policy es un decorador del `Executor`, así que aplica igual en MCP, en plugins y en cualquier executor.
6. El worker es el default, por la revisión de Sonnet (C1/H3): cuesta ~100 ms por ejecución; inline cuesta ~5 ms.
7. TypeScript sin build: Node ≥ 22.18 con type stripping, e imports con extensión `.ts`.

## Archivos clave
`src/executor/{worker-executor,worker-entry,quickjs-executor,default}.ts` · `src/policy.ts` · `src/mcp.ts` · `src/discovery.ts` · `src/runner.ts` · `src/recipes.ts` · `src/sandbox/helpers.js` · `src/vendor/` (MIT, Cloudflare @841b6fc) · `tests/` (incluye `review-regressions.test.ts`) · `examples/` · `bench/` · `README.md`, `RESEARCH.md`, `ARCHITECTURE.md`, `THIRD_PARTY_NOTICES.md`

## Cómo ejecutarlo
```bash
git clone git@github.com:fegome90-cmd/code-dope.git && cd code-dope && git checkout feat/code-mode-library
npm ci
npm run test:all          # 51 JS + 2 Python + typecheck (~25 s)
npm run example:plugin
npm run example:mcp       # o: node examples/mcp-client/run.ts tickets
npm run bench
```

## Fallas y riesgos conocidos
- QuickJS-emscripten no está auditado. Un worker comparte proceso con el host (no es un límite de SO): para código hostil, agrega un contenedor.
- La prompt injection desde los resultados de herramientas se advierte en las descripciones, pero no se filtra.
- Una escritura que vence por timeout puede completarse igual (auditada como `outcome: "unknown"`). Las escrituras deberían ser idempotentes.
- Un nombre de herramienta sin `proveedor.` aplica a todos los proveedores.
- Ruido esperado: en modo inline, un desbordamiento de stack imprime `Aborted(Assertion failed…)` en stderr. Es emscripten; el módulo se recicla. En modo worker el mensaje se captura.
- NOT_VERIFIED: tokens reales y latencia de un modelo en el loop, si un modelo escribe bien este código por sí solo, el soporte de PTC en Haiku 5.5 y el advisory de isolated-vm.

## Dónde parte la siguiente fase (opciones, elige una)
1. **Mergear el PR #2**: decisión tuya; no se hizo.
2. **Evaluación con modelo real**: mismo workflow del benchmark, con la API de Anthropic y `count_tokens`, comparando baseline y Code Mode. Requiere API key y tiene costo, así que pide autorización.
3. **Pool de workers**: reutilizar workers precalentados para bajar los ~100 ms, reciclándolos ante cualquier fallo. Hay que mantener las regresiones C1/H3 en verde.
4. **Aprobaciones diferidas** (pausar y reanudar), si algún consumidor lo necesita.
5. **Integrar en un consumidor real** (por ejemplo Toolshed-lite): es otro repo, solo con tu autorización explícita.

Modelo sugerido para la Fase 2: **Sonnet 5.5** para 1, 3 o 5 (implementación acotada, con pruebas existentes como red), y **Opus 5.5 con esfuerzo medio** solo si eliges 2 o 4 (diseño de la evaluación o del flujo de aprobación).
