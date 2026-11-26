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
- Modo `inline`: la ejecución de QuickJS es síncrona en el hilo de Node, así que un bucle de CPU bloquea el event loop hasta el deadline [R, S3]. El modo `worker` (por defecto) lo evita a cambio de ~100 ms por ejecución [R]. Un worker comparte proceso, no es un límite de SO.
- El límite de memoria se cumple ("out of memory") [R], pero con heaps grandes el GC puede tardar segundos y el timeout llega antes [R].
- Las herramientas upstream son una fuente de prompt injection: sus descripciones se insertan en las descripciones de las herramientas. El generador de Cloudflare escapa JSDoc [O]. La policy acota lo que el código inyectado puede hacer.

## 6. Resultados reproducidos (pruebas propias)

Ver `tests/` y `bench/RESULTS.json`. Benchmark resumido en el README. Las cifras de terceros (98,7 % de Anthropic, 99,9 % de Cloudflare, 67-88 % de UTCP) **no** se usan como resultados propios.

## 7. Revisión independiente (Sonnet, S3) y correcciones

Revisión con unas 45 sondas ejecutadas, sin acceso al veredicto de Opus. Todos los hallazgos marcados como reproducidos se corrigieron y tienen prueba de regresión en `tests/review-regressions.test.ts`.

| ID | Hallazgo | Corrección |
|---|---|---|
| C1 | El desbordamiento de stack del guest dejaba inservible el módulo WASM del proceso (después de ~9 veces, todo fallaba) [R] | El módulo se recicla cuando la limpieza falla, y en el modo worker por defecto el estado muere con el worker [R: 20 desbordamientos y luego OK] |
| H1 | Presupuesto de llamadas evadido con `approve` asíncrono y llamadas concurrentes [R] | El cupo se reserva de forma síncrona antes del primer `await` |
| H2 | `deny`/`validate` con nombres originales (`delete-user`) no aplicaban en search/execute [R] | Comparación de nombres sanitizada en ambos lados; fns indexadas por el nombre original; la búsqueda solo muestra herramientas permitidas |
| H3 | Un bucle de CPU bloqueaba el event loop del host [R] | `WorkerExecutor` es ahora el executor por defecto [R: el host sigue con ticks durante el bucle] |
| M1 | Los nombres sanitizados que anuncia `codeMcpServer` no resolvían [R] | El executor resuelve los alias sanitizados |
| M2 | El log de auditoría crecía sin límite [R] | `createAuditLog(max=1000)` + contador `dropped` |
| M3 | Una escritura vencida por timeout podía completarse y quedaba auditada como fallida [R] | `outcome: "unknown"` y mensaje explícito; documentado que las escrituras deberían ser idempotentes |
| M4 | Hooks que lanzaban excepción no dejaban registro de auditoría [R] | Se capturan y se registran como denegación |
| M5 | El aprobador podía mutar los argumentos ejecutados [R] | Los hooks reciben `structuredClone` |
| M6 | Un nombre sin proveedor aplica a todos los proveedores | Documentado (`proveedor.tool` para acotar) |
| M7 | ArrayBuffer desacoplado con más de 20 000 llamadas en vuelo [R] | Tope `maxPendingCalls` (64) |
| M8 | Un resultado muy anidado rompía la serialización del host [R] | Verificación de serialización en el executor y `try/catch` en discovery |
| M9 | Un comentario final rompía el wrapper [R] | Salto de línea antes de `)` |
| L1–L3 | `patch` podía pisar el id; recipes no null-safe; `ok: true` con resultado truncado; cursor repetido | Validación en build, null-safe, `ok: !truncated`, detección de `stalled` |
| L4 | Ranking sin prefijos; una consulta vacía devolvía herramientas | Coincidencia por prefijo de 3+ caracteres; consulta vacía → nada |
| L5 | `unwrap` sin la rama `toolResult` | Agregada |
| L6 | Prompt injection desde herramientas | Advertencia en las descripciones; sin filtrado (riesgo residual) |
| L7 | `retry` reintentaba denegaciones | Las denegaciones no se reintentan |
| L8 | Prefijo `[error]` falsificable en logs; sin tope de ejecuciones concurrentes | Riesgo residual documentado |
| L9 | Metodología del benchmark (acumulado adelantado un turno, percentiles) | Corregida y benchmark re-ejecutado |

## 8. Preguntas abiertas

- Si Haiku 5.5 soporta PTC no está confirmado (H2). Verificarlo con la Models API antes de usar el snippet con ese modelo.
- Advisory de isolated-vm (GHSA-864f-rcv7-6rh4): sin verificar en la fuente primaria. Solo importa si alguien elige isolated-vm.
- Si un modelo real escribe código correcto contra estos helpers: NOT_VERIFIED. No hubo modelo en el loop.
- Aprobaciones asíncronas o diferidas (pausar y reanudar) en Node: fuera del alcance actual.

## 9. Evidencia de delegación

Lanzados con la herramienta Agent del entorno, tipo `Explore` (sin Edit/Write/NotebookEdit ni Agent, es decir, solo lectura y sin redelegación), con `model` forzado. El modelo autodeclarado en la primera línea de cada informe coincide con el forzado. La autodeclaración por sí sola es evidencia débil; la configuración efectiva es el parámetro `model` del harness. Las métricas son las que devolvió el harness.

| Tarea | Modelo solicitado / autodeclarado | Estado | Uso de herramientas | Duración | Aporte decisivo |
|---|---|---|---|---|---|
| H1 docs Cloudflare | haiku / claude-haiku-5-5 | DONE | 5 | 69 s | Estado experimental; API actual frente a la del blog 2025 (obsoleta) |
| H2 docs Anthropic | haiku / claude-haiku-5-5 | DONE | 9 | 82 s | Contrato PTC (dict → string), tool types, límites |
| H3 inventario ecosistema | haiku / claude-haiku-5-5 | DONE | 29 | 100 s | Opciones de sandbox para Node y licencias |
| S1 código @cloudflare/codemode | sonnet / claude-sonnet-5-5 | DONE | 14 | 86 s | No hay executor para Node; módulos portables; `./mcp` reutilizable |
| S2 código UTCP + seguridad | sonnet / claude-sonnet-5-5 | DONE | 13 | 116 s | `register_manual` crítico; Python sin aislamiento; descartar como dependencia |
| S3 revisión independiente | sonnet / claude-sonnet-5-5 | DONE | 21 (~45 sondas) | 381 s | C1, H1–H3, M1–M9 (ver §7) |

Opus verificó por su cuenta los hallazgos decisivos: la falla de import de la raíz y la carga de `./mcp` en Node [R], el contrato `Executor` [O] y la reproducción de cada hallazgo de S3 como prueba de regresión [R].
