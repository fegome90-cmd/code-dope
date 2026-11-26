# RESEARCH — registro de investigación

Fecha de consulta: 2026-11-26. Etiquetas de evidencia:
**[O]** observado en código o documento · **[R]** reproducido con prueba propia · **[I]** inferencia técnica · **[H]** hipótesis · **[A]** afirmación del autor (no verificada).

## 1. Fuentes primarias y versiones

| Fuente | Versión / commit | Inspeccionado por |
|---|---|---|
| github.com/cloudflare/agents, `packages/codemode` | commit `841b6fc` (2026-11-26), `@cloudflare/codemode` 0.5.6, MIT | Sonnet (S1, código), Opus (código + npm) |
| npm `@cloudflare/codemode@0.5.6` (dist publicado) | 0.5.6 | Opus [R] |
| blog.cloudflare.com/code-mode/ (2025-09-26), /code-mode-mcp/ (2026-02-20) | — | Haiku (H1) |
| developers.cloudflare.com/agents/tools/codemode/{how-it-works,mcp}, …/build-codemode-mcp-server/ | — | Haiku (H1) |
| github.com/universal-tool-calling-protocol/code-mode | commit `e5fdc31` (2026-08-25); TS 1.2.13 MPL-2.0, Python 1.1.0 MPL-2.0, MCP 1.2.1 MIT, CLI 0.1.2 MIT | Sonnet (S2), Haiku (H3) |
| anthropic.com/engineering/code-execution-with-mcp, …/advanced-tool-use | — | Haiku (H2) |
| platform.claude.com docs: programmatic-tool-calling, code-execution-tool, tool-search-tool | — | Haiku (H2) |
| github.com/anthropics/claude-cookbooks (solo nivel superior) | — | Haiku (H2) |
| quickjs-emscripten 0.32.0 (MIT), isolated-vm, node:vm, SES, Deno, Monty, smolagents, CodeAct, E2B | — | Haiku (H3) |

## 2. Hallazgos que decidieron la arquitectura

1. **El entry raíz de `@cloudflare/codemode` no carga en Node** porque importa `cloudflare:workers`. [R] `import("@cloudflare/codemode")` → *"Received protocol 'cloudflare:'"*. Lo mismo ocurre con `./ai`, que importa `connectors/base.ts` (WorkerEntrypoint). [O, S1]
2. **`@cloudflare/codemode/mcp` sí carga en Node** (con `@cfworker/json-schema` instalado) y `codeMcpServer({ server, executor })` acepta **cualquier** `Executor`. [R] → se reutiliza tal cual.
3. **No existe un executor para Node en Cloudflare**: solo `DynamicWorkerExecutor` (Workers) e `IframeSandboxExecutor` (navegador). El README menciona un ejemplo "Node VM" que no existe en el código. [O, S1] → necesidad demostrada para el nivel 3.
4. El contrato `Executor.execute(code, providers|fns) → {result, error?, logs?}` (executor-types.ts:46-61) es pequeño y portable. [O]
5. En Cloudflare, el aislamiento depende de workerd (`globalOutbound: null`) y de no inyectar `bindings`. La librería no lo verifica. [O, S1]
6. `codeMcpServer` mete los tipos de **todas** las herramientas en la descripción, así que no hace descubrimiento progresivo. El patrón search/describe/execute de Cloudflare vive en clases atadas a Workers (`proxy-tool.ts`, `connectors/base.ts`). [O, S1]
7. Los módulos puros (`normalize.ts`, `json-schema-types.ts`, `utils.ts`) no tienen subpath export. Para reutilizarlos hay que copiarlos con la nota de licencia MIT. [O, S1]
8. **UTCP code-mode (TS)** aísla con `isolated-vm` (módulo nativo, peer dependency obligatoria). No tiene allowlist por ejecución, no valida argumentos, no limita el número de llamadas, y su array de `logs` del lado host no tiene tope. [O, S2]
9. **UTCP code-mode-mcp**: `register_manual` permite que el modelo registre plantillas `cli`/`file`, es decir, ejecutar comandos en el host saltándose el sandbox por diseño. Severidad crítica. [O, S2]
10. **UTCP Python**: RestrictedPython + `exec` en el mismo proceso, con `_getattr_ = getattr` y `asyncio`/`time` expuestos. No sirve como sandbox; un bucle infinito cuelga el proceso. [O + I, S2]
11. **Las afirmaciones de seguridad del README de UTCP exageran**: dice "Node.js VM sandboxing" cuando en realidad usa isolated-vm, y "zero network" cuando las herramientas sí hacen I/O. [O vs A, S2]
12. `node:vm` no es un mecanismo de seguridad (documentación de Node). isolated-vm advierte que no es un límite endurecido. SES no limita CPU ni memoria. QuickJS-emscripten no está auditado. [A, citados por H3]
13. **Anthropic PTC**: las herramientas son funciones async de Python que reciben un dict y devuelven un string. Los resultados programáticos no entran al contexto del modelo. `allowed_callers` no es un límite de seguridad. Hay timeout de ~4 min por llamada pendiente. [O doc, H2]
14. Patrones agnósticos del proveedor (Anthropic + Cloudflare): filtrar o agregar en código antes de devolver al modelo; descubrimiento bajo demanda; credenciales fuera del sandbox; aprobación por llamada. [O doc]

## 3. Componentes reutilizados y procedencia

| Componente en code-dope | Procedencia | Forma |
|---|---|---|
| `codeMcpServer` (descubrimiento upstream en memoria, tipos, unwrap de resultados MCP, truncado) | `@cloudflare/codemode/mcp` 0.5.6 | **dependencia** (MIT) |
| Contrato `Executor`, `ExecuteResult`, `ResolvedProvider` | `@cloudflare/codemode` (solo tipos) | dependencia, `import type` |
| `src/vendor/cf-normalize.ts` | cloudflare/agents `packages/codemode/src/normalize.ts` @841b6fc | copia sin cambios (MIT) |
| `src/vendor/cf-json-schema-types.ts`, `cf-utils.ts` | ídem `json-schema-types.ts`, `utils.ts` | copia, solo rutas de import (MIT) |
| `unwrap()` en `src/discovery.ts` | mismo orden de prioridad que `unwrapMcpResult` de Cloudflare (mcp.ts) | reescrito, unas 15 líneas |
| Sandbox | `quickjs-emscripten` 0.32.0 | dependencia (MIT) |

Código propio, por falta de una alternativa compatible: `QuickJSExecutor`, `policy.ts`, `runner.ts`, `discovery.ts` (búsqueda léxica + servidor search/execute), `sandbox/helpers.js`, `recipes.ts`, `snippets/ptc_helpers.py`.

## 4. Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Depender de `@utcp/code-mode` | Peer dependency nativa `isolated-vm` (requiere compilación o prebuilds en Node ≥20 y `--no-node-snapshot`), sin policy, MPL-2.0. H3 reporta un advisory 2026 de escape en isolated-vm, pero viene de una sola nota de prensa, sin verificar en GHSA [H]. |
| Adaptar el código de UTCP | MPL-2.0 es copyleft por archivo. Su valor real está en el diseño (puente de strings, `dispose` defensivo, tests de timeout), que se adoptó como idea sin copiar código. |
| `node:vm` / `new Function` | No es un límite de seguridad (documentación de Node) y viola la sección 9 del ancla. |
| isolated-vm directo | Módulo nativo, mantenimiento limitado y advisory reportado [H]. QuickJS-WASM no tiene dependencias nativas y no expone ninguna API de Node. |
| SES | No limita CPU ni memoria [A]. |
| Deno / E2B / contenedores | Más fuertes, pero agregan proceso o servicio externo (E2B es facturable). Se documentan como capa adicional para cargas hostiles. |
| Biblioteca Python duplicada | Sin necesidad demostrada. Solo se agregó un snippet Python pequeño porque Claude PTC, el host nativo concreto, ejecuta únicamente Python. |
| Búsqueda semántica (embeddings) | Infraestructura innecesaria. Cloudflare y UTCP también usan ranking léxico [O]. |
| Motor de replay/aprobación durable de Cloudflare (`runtime.ts`) | Atado a Durable Objects. Reimplementarlo sería construir un runtime propio. La aprobación síncrona por llamada cubre la necesidad actual. |

## 5. Riesgos de seguridad conocidos

- QuickJS-emscripten no está auditado [A, README del proyecto]. Mitigación: sin handles del host en el guest, solo strings JSON, límites de memoria, stack y tiempo. Para código hostil, usar además un proceso separado o un contenedor.
- La ejecución de QuickJS es síncrona en el hilo de Node: un bucle de CPU bloquea el event loop hasta el deadline del interrupt handler. [I + R: el bucle se corta al llegar al timeout]
- El límite de memoria se cumple ("out of memory") [R], pero con heaps grandes el GC puede tardar segundos y el timeout llega antes [R].
- Las herramientas upstream son una fuente de prompt injection: sus descripciones se insertan en las descripciones de las herramientas. El generador de Cloudflare escapa JSDoc [O]. La policy acota lo que el código inyectado puede hacer.

## 6. Resultados reproducidos (pruebas propias)

Ver `tests/` y `bench/RESULTS.json`. Benchmark resumido en el README. Las cifras de terceros (98,7 % de Anthropic, 99,9 % de Cloudflare, 67-88 % de UTCP) **no** se usan como resultados propios.

## 7. Preguntas abiertas

- Si Haiku 5.5 soporta PTC no está confirmado (H2). Verificarlo con la Models API antes de usar el snippet con ese modelo.
- Advisory de isolated-vm (GHSA-864f-rcv7-6rh4): sin verificar en la fuente primaria. Solo importa si alguien elige isolated-vm.
- Si un modelo real escribe código correcto contra estos helpers: NOT_VERIFIED. No hubo modelo en el loop.
- Aprobaciones asíncronas o diferidas (pausar y reanudar) en Node: fuera del alcance actual.
