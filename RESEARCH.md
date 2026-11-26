# RESEARCH — registro de investigación

Fecha de consulta: 2026-11-26. Etiquetas de evidencia:
**[O]** observado en código o documento · **[R]** reproducido con prueba propia · **[I]** inferencia técnica · **[H]** hipótesis · **[A]** afirmación del autor (no verificada).

## 1. Fuentes primarias y versiones

Versiones comprobadas el 2026-11-26. `latest` describe el registro en esa fecha, no una garantía futura. Las referencias de código históricas mantienen su commit de inspección.

| Fuente | Versión / commit | Evidencia |
|---|---|---|
| [cloudflare/agents, packages/codemode](https://github.com/cloudflare/agents/tree/841b6fc/packages/codemode) | `841b6fc` (2026-11-26), MIT | Revisión de código S1 y verificación del implementador [O] |
| [Registro npm: @cloudflare/codemode](https://registry.npmjs.org/%40cloudflare%2Fcodemode) | `latest: 0.5.6`, publicado el 2026-10-29 | Registro primario [O]; import y ejecución en Node [R] |
| [Blog Code Mode](https://blog.cloudflare.com/code-mode/) y [Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/) | 2025-09-26 y 2026-02-20 | Revisión documental H1 [O] |
| [Referencia API de Code Mode](https://developers.cloudflare.com/agents/tools/codemode/api-reference/) y [guía MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/) | Consultadas el 2026-11-26 | Revisión H1 y actualización de Fase 3 [O doc] |
| [UTCP code-mode](https://github.com/universal-tool-calling-protocol/code-mode/tree/e5fdc31) | `e5fdc31` (2026-08-25); TS 1.2.13 MPL-2.0, Python 1.1.0 MPL-2.0, MCP 1.2.1 MIT | Revisiones S2 y H3 [O] |
| [Registro npm: @utcp/code-mode-cli](https://registry.npmjs.org/%40utcp%2Fcode-mode-cli) | `latest: 0.1.1`, publicado el 2026-06-18 | Corrección de la versión de CLI del registro anterior [O] |
| [Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) y [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) | Investigación histórica | Revisión documental H2 [O] |
| [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool) y [PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) | Versión vigente `code_execution_20260521`; 90 s de reloj por celda Python de PTC | Documentación consultada el 2026-11-26 [O doc] |
| [Cookbooks oficiales](https://github.com/anthropics/claude-cookbooks) | Solo nivel superior | Revisión H2 [O] |
| [Registro npm: quickjs-emscripten](https://registry.npmjs.org/quickjs-emscripten) | `latest: 0.32.0`, publicado el 2026-02-16; MIT | Registro primario [O] |
| [Advisory isolated-vm](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4) | Crítico; corregido en 6.2.0 y 7.0.1 | Fuente primaria verificada en Fase 3 [O] |

La revisión H3 también inventarió `node:vm`, SES, Deno, Monty, smolagents, CodeAct y E2B. No son dependencias de esta biblioteca.

## 2. Hallazgos que decidieron la arquitectura

1. **El entry raíz de `@cloudflare/codemode` no carga en Node** porque importa `cloudflare:workers`. [R] `import("@cloudflare/codemode")` → *"Received protocol 'cloudflare:'"*. Lo mismo ocurre con `./ai`, que importa `connectors/base.ts` (WorkerEntrypoint). [O, S1]
2. **`@cloudflare/codemode/mcp` sí carga en Node** (con `@cfworker/json-schema` instalado) y `codeMcpServer({ server, executor })` acepta **cualquier** `Executor`. [R] → se reutiliza tal cual.
3. **No existe un executor para Node en Cloudflare**: solo `DynamicWorkerExecutor` (Workers) e `IframeSandboxExecutor` (navegador). El README menciona un ejemplo "Node VM" que no existe en el código. [O, S1] → necesidad demostrada para el nivel 3.
4. El contrato `Executor.execute(code, providers|fns) → {result, error?, logs?}` (executor-types.ts:46-61) es pequeño y portable. [O]
5. En Cloudflare, el aislamiento depende de workerd (`globalOutbound: null`) y de no inyectar `bindings`. La librería no lo verifica. [O, S1]
6. `codeMcpServer` inserta los tipos de todas las herramientas upstream en la descripción; ese wrapper no ofrece descubrimiento progresivo. La conclusión histórica sobre todo search/execute era demasiado amplia: [`openApiMcpServer` de `@cloudflare/codemode/mcp`](https://developers.cloudflare.com/agents/tools/codemode/api-reference/#openapimcpserver) ofrece `search` sobre el documento OpenAPI y `execute` con un callback host [O doc]. Se reprodujeron ambos métodos en Node v24.22.3, con `WorkerExecutor`, transporte MCP en memoria y callback sintético [R]. El runtime durable con conectores sigue atado a Workers; el wrapper OpenAPI es una alternativa portable para ese formato de API, sin sustituir la búsqueda del catálogo MCP implementada aquí.
7. Los módulos puros (`normalize.ts`, `json-schema-types.ts`, `utils.ts`) no tienen subpath export. Para reutilizarlos hay que copiarlos con la nota de licencia MIT. [O, S1]
8. **UTCP code-mode (TS)** aísla con `isolated-vm` (módulo nativo, peer dependency obligatoria). No tiene allowlist por ejecución, no valida argumentos, no limita el número de llamadas, y su array de `logs` del lado host no tiene tope. [O, S2]
9. **UTCP code-mode-mcp**: `register_manual` permite que el modelo registre plantillas `cli`/`file`, es decir, ejecutar comandos en el host saltándose el sandbox por diseño. Severidad crítica. [O, S2]
10. **UTCP Python**: RestrictedPython + `exec` en el mismo proceso, con `_getattr_ = getattr` y `asyncio`/`time` expuestos. No sirve como sandbox; un bucle infinito cuelga el proceso. [O + I, S2]
11. **Las afirmaciones de seguridad del README de UTCP exageran**: dice "Node.js VM sandboxing" cuando en realidad usa isolated-vm, y "zero network" cuando las herramientas sí hacen I/O. [O vs A, S2]
12. `node:vm` no es un mecanismo de seguridad (documentación de Node). isolated-vm advierte que no es un límite endurecido. SES no limita CPU ni memoria. QuickJS-emscripten no está auditado. [A, citados por H3]
13. **Anthropic PTC**: las herramientas se llaman desde Python y sus resultados intermedios no entran al contexto del modelo. La [documentación](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) excluye herramientas de conectores MCP y `strict: true`, e impide forzar una llamada programática específica mediante `tool_choice` [O doc]. El timeout de una llamada pendiente ronda cuatro minutos; es distinto del límite de 90 s por celda. `allowed_callers` describe contextos de llamada. La frase «no es un límite de seguridad» no figura en esa documentación: se conserva como inferencia de que no sustituye la autorización del host [I].
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
| Depender de `@utcp/code-mode` | Peer dependency nativa `isolated-vm` (compilación o prebuilds en Node ≥20 y `--no-node-snapshot`), sin policy por ejecución y MPL-2.0 [O, S2]. El [advisory GHSA-864f-rcv7-6rh4](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4), inicialmente pendiente de confirmar, está verificado en la fuente primaria: crítico, corregido en 6.2.0 y 7.0.1 [O]. Esto no implica que las versiones corregidas mantengan ese defecto. |
| Adaptar el código de UTCP | MPL-2.0 es copyleft por archivo. Su valor observado está en el diseño del puente de strings, el `dispose` defensivo y los tests de timeout; se adoptaron como ideas sin copiar código. |
| `node:vm` / `new Function` | No constituyen el límite de seguridad requerido y están prohibidos para código del modelo en el host. Ver [documentación de Node](https://nodejs.org/api/vm.html). |
| isolated-vm directo | Dependencia nativa y costo de integración, más el historial de vulnerabilidades confirmado. QuickJS-WASM evita la dependencia nativa y no expone APIs de Node al guest. No se afirma que WASM elimine todo riesgo de escape. |
| SES | No aporta límites de CPU ni memoria [A, investigación H3]. |
| Deno / E2B / contenedores | Agregan proceso o servicio externo; E2B es facturable. El aislamiento de proceso o contenedor queda como capa adicional para cargas hostiles. |
| Biblioteca Python duplicada | Sin necesidad demostrada. El snippet Python cubre la orquestación de herramientas de PTC; no implica que la herramienta de ejecución de código solo admita Python. |
| Búsqueda semántica (embeddings) | Infraestructura innecesaria para el alcance actual; las implementaciones inspeccionadas también usan búsqueda léxica [O]. |
| Motor de replay/aprobación durable de Cloudflare (`runtime.ts`) | Atado a Durable Objects. La aprobación por llamada durante la ejecución cubre la necesidad actual; pausar y reanudar queda fuera de alcance. |

## 5. Riesgos de seguridad conocidos

- QuickJS-emscripten no está auditado según el [README del proyecto](https://github.com/justjake/quickjs-emscripten) [A]. Mitigaciones propias: puente JSON sin handles del host en el guest, límites de memoria, stack y tiempo. Para código hostil, agregar aislamiento de proceso o contenedor.
- `inline` bloquea el event loop mientras el guest consume CPU: M5 observó **0 ticks** durante el bucle [R]. `worker`, el modo por defecto, mantiene la capacidad de respuesta del host; el bench actual midió p50 61,53 ms frente a 2,44 ms inline. Un worker comparte proceso y no proporciona un límite de sistema operativo.
- `pool` reutiliza el módulo WASM entre ejecuciones exitosas. Cada ejecución crea runtime/contexto nuevos y el worker se recicla ante error o al llegar a `maxUses`; el reaping por `idleMs` reduce los workers ociosos. Estas medidas limitan la exposición, pero no equivalen a una auditoría de aislamiento [I]. La segunda corrida completa del soak acota memoria y latencia de esa carga; no prueba ausencia general de fugas ni seguridad ante código hostil.
- El primer intento completo del soak terminó con **exit 139 / `Segmentation fault`**, stdout y stderr vacíos, sin ventanas documentadas y con número de ejecuciones completadas desconocido [R]. La causa nativa permanece abierta. Comparaciones de 500 ejecuciones por configuración antes y después de M4 completaron sin fallo, pero no permiten atribuir causalidad. La corrida completa posterior tampoco descarta el crash ni valida estabilidad general.
- Una asignación masiva con heap de **256 MiB** produjo `out of memory` en M5 [R]. El test acepta agotamiento de memoria o timeout; cuál ocurre primero depende de la carga y del runtime. No se conserva como resultado determinista la afirmación de que el GC hace vencer siempre el timeout antes.
- M1 cierra el estado de policy en `finally`: ninguna llamada nueva llega a `fn` después del cierre; una aprobación tardía queda denegada. Las funciones host que ya comenzaron no son cancelables por este wrapper. Si terminan después, se auditan con `afterExecutionEnd: true`; el timeout por llamada sigue dejando `outcome: "unknown"` cuando el efecto puede completarse [R]. `guardFns` usado sin estado de ejecución no tiene cierre automático.
- M2 aplica allowlists exactas cuando dos nombres reales comparten alias sanitizado; `deny` mantiene la comparación sanitizada. Ante colisión, los tipos y descripciones MCP excluyen las variantes no permitidas y anuncian las admitidas sin alias ambiguos [R]. El servidor `code` conserva los metadatos de los nombres sin colisión; esa visibilidad no concede permiso de ejecución.
- Las descripciones upstream siguen siendo una fuente de prompt injection. Escapar JSDoc protege la sintaxis, pero no elimina ese contenido. La policy limita las operaciones alcanzables; no verifica la intención del código [O + I].

## 6. Resultados reproducidos (pruebas propias)

La evidencia ejecutable está en `tests/`, [bench/RESULTS.json](bench/RESULTS.json) y [bench/SOAK.json](bench/SOAK.json); §10 resume los resultados de esta fase. Las cifras publicadas por terceros no se presentan como mediciones propias.

En el catálogo sintético de **83 herramientas** (80 sintéticas + 3 reales), el test existente de discovery midió **39 816 frente a 1 709 caracteres** de `listTools`: **23,30×** de reducción. Tres corridas devolvieron las mismas cifras; el umbral se elevó a **20×** [R]. La medición corresponde a ese fixture, no a todos los catálogos ni a una estimación de tokens.

## 7. Revisión independiente de Fase 1 (S3) y correcciones

Revisión histórica con unas 45 sondas, sin acceso al veredicto del implementador. Los hallazgos reproducidos se corrigieron con regresiones en `tests/review-regressions.test.ts`. Los IDs de esta tabla pertenecen a Fase 1; no son los M1–M9 de PLAN Fase 3.

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

## 8. Preguntas abiertas y límites de verificación

- **PTC del modelo objetivo de M8:** confirmado en la [tabla de disponibilidad oficial](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling#availability) [O doc]. La consulta a Models API requiere autorización separada y sigue **NOT_RUN**; no hubo credenciales ni llamadas de M8.
- **Advisory isolated-vm:** cerrado documentalmente con la [fuente primaria](https://github.com/laverdet/isolated-vm/security/advisories/GHSA-864f-rcv7-6rh4) [O]. No se reprodujo el exploit y no se incorporó esa dependencia.
- **Evaluación con un modelo real:** **NOT_VERIFIED / M9 NOT_RUN**. Las pruebas usan código sintético, no generación en el loop.
- **Aprobaciones durables:** pausar/reanudar una ejecución tras su cierre sigue fuera del alcance. La aprobación asíncrona dentro de una ejecución viva sí está cubierta por M1 y H1.
- **Pool:** causa del `Segmentation fault` del primer soak, estabilidad general, tamaño óptimo y aislamiento auditado permanecen **NOT_VERIFIED**. La segunda corrida completa terminó sin alertas de los umbrales definidos; no cierra el fallo nativo. Tampoco hay integración verificada en otro repositorio consumidor.
- **Instalación con gestores alternativos:** el prototipo previo de D1 probó pnpm desde `git+file://`; no se repitió aquí. La prueba de paquete de esta fase instala el tarball con npm. No atribuir a esta corrida una prueba nueva de pnpm o Bun.

## 9. Evidencia de delegación

### Registro histórico de Fase 1

El registro original documentó tareas de exploración de solo lectura. La tabla conserva sus métricas históricas; no son ejecuciones ni recibos nuevos de Fase 3. Se usan roles e IDs de tarea para la atribución.

| Tarea | Responsable | Estado registrado | Uso de herramientas | Duración registrada | Aporte |
|---|---|---|---|---|---|
| H1 docs Cloudflare | Revisor documental | DONE | 5 | 69 s | API vigente frente al blog 2025 |
| H2 docs Anthropic | Revisor documental | DONE | 9 | 82 s | Contrato PTC y límites |
| H3 inventario ecosistema | Revisor de alternativas | DONE | 29 | 100 s | Sandbox para Node y licencias |
| S1 código @cloudflare/codemode | Revisor de código | DONE | 14 | 86 s | Módulos portables y subpath MCP |
| S2 código UTCP y seguridad | Revisor de código | DONE | 13 | 116 s | Riesgos de registro y aislamiento |
| S3 revisión independiente | Revisor de regresiones | DONE | 21, unas 45 sondas | 381 s | Hallazgos de §7 |

El implementador histórico contrastó los hallazgos decisivos mediante imports, inspección del contrato y regresiones. El [PLAN](PLAN.md) registra además una revisión previa a Fase 3 con **cuatro subagentes**: tres verificaron fuentes externas y uno contrastó investigación con código. Sus recibos individuales no se recuperaron en esta ejecución; no se añaden métricas ni se presentan como la delegación actual.

### Ejecución actual de Fase 3

Se realizaron **tres delegaciones directas a subagentes de Codex** y una subrevisión delegada por el agente de pool, con responsabilidades acotadas:

| Rol | Trabajo delegado |
|---|---|
| Entorno y fuentes | Instalación, versiones, fuentes primarias M7 y smoke OpenAPI en Node |
| Seguridad y verificación | Pruebas a ciegas de M1/M2, revisión y comprobaciones de M5 |
| Pool y carga | Revisión de M4 y elaboración/revisión estática del soak M6 |
| Subrevisión de bench y runtime | Apoyo al bench M4, lectura de la limpieza del runtime y revisión de cifras/documentación M7 |

El agente principal integró los cambios, ejecutó todas las cargas y gates, y mantuvo commits/pushes secuenciales. La suite independiente contiene **60 pruebas** (15 de M1 y 45 de M2), escritas desde la especificación antes de revisar los arreglos. Las pruebas de implementación son adicionales. No se atribuyen a estos subagentes identidades o métricas del entorno histórico.

## 10. Fases 2 y 3: implementación y evidencia

### Fase 2: pool opt-in

`PooledWorkerExecutor` implementa `Executor` con `isolation: "pool"`; el default continúa siendo `worker`. Comparte el puente de herramientas del padre, precalienta WASM, usa un runtime/contexto nuevo por ejecución y ofrece `stats`/`close()`. Recicla ante errores y `maxUses`, y elimina ociosos mediante `idleMs`. El [handoff de Fase 2](HANDOFF-2026-11-26-PHASE-2.md) registró 71 pruebas JS, 2 Python y typecheck en verde; ese fue también el baseline de esta ejecución.

### Fase 3: cambios y gates

| Mejora | Resultado comprobado |
|---|---|
| M1 | Estado de ejecución cerrado en `finally`, `AbortSignal` para aprobación y auditoría de terminaciones tardías. Reproducción: `writes: 1` con `allowed/done` antes; `writes: 0` con decisión `denied` después. Cobertura inline, worker y pool. |
| M2 | Colisiones detectadas por proveedor; `read`, `write` y validación usan nombres exactos ante ambigüedad; `deny` sigue sanitizado. Reproducción: se invocaban ambas variantes; ahora solo `delete_user`, con denegación explícita de `delete-user`. Los tipos y descripciones de ambos servidores MCP excluyen las variantes no permitidas cuando colisionan; el servidor `code` conserva metadatos de nombres sin colisión. |
| M3 | Distribución JS y declaraciones en `dist/`, commiteada y sin `prepare`; TS fijado en 5.9.3. Se comprueba deriva y se instala el tarball en un consumidor temporal. El desarrollo sigue importando fuentes TS. |
| M4 | Reemplazos precalentados tras reciclaje, preferencia por workers listos y `stats.warming`. El reaping por inactividad no repone workers. Las pruebas de contrato protegidas conservaron sus expectativas. |
| M5 | Evidencia para bloqueo inline (0 ticks), rama `toolResult`, límite de heap con resultado no determinista, fallo del entry raíz Cloudflare y ratio discovery de 23,30×. |
| M6 | DONE según aceptación de reporte: segundo intento completo con 5 000 ejecuciones por configuración de `maxUses` (100 y 1 000), tamaño 2 y mezcla 90 % OK / 5 % throw / 5 % timeout. El crash nativo del primer intento sigue abierto; detalle abajo. |
| M7 | Documentación ajustada a evidencia primaria, resultados de esta ejecución y límites de verificación. |

| Gate | Pruebas JS | Prueba de paquete | Gates adicionales |
|---|---:|---:|---|
| Baseline | 71 | — | 2 Python + typecheck |
| Después de M1 | 89 | — | 2 Python + typecheck |
| Después de M2 | 137 | — | 2 Python + typecheck |
| Después de M3 | 137 | 1 | 2 Python + typecheck + `check:dist` |
| Después de M4 | 141 | 1 | 2 Python + typecheck + `check:dist` |
| Después de M5 | 145 | 1 | 2 Python + typecheck + `check:dist` |
| Después de M6 | 145 | 1 | 2 Python + typecheck + `check:dist` |
| Después de M7 | 145 | 1 | 2 Python + typecheck + `check:dist` |

Desde M3, `test:all` incorpora `check:dist` y `test:pkg`. Los SHA-256 de `tests/review-regressions.test.ts`, `tests/executor.test.ts` y `tests/pool-contract.test.ts` permanecen idénticos al baseline; `src/vendor/` permanece sin cambios. M8 y M9 no se ejecutaron.

### Benchmark actual

Medición sintética en Node **v24.22.3**, **20 corridas** por caso; latencias en ms. Los percentiles describen esta máquina y esta carga, sin promesa de rendimiento universal. Ver [RESULTS.json](bench/RESULTS.json).

| Ejecutor / condición | p50 | p95 |
|---|---:|---:|
| Worker efímero | 61,53 | 87,29 |
| Pool caliente | 2,74 | 5,88 |
| Primera ejecución de pool después de un error, con margen de 150 ms | 6,07 | 7,94 |
| Pool en frío, `prewarm: false` | 50,92 | 53,81 |
| Inline | 2,44 | 4,64 |

El caso tras error cumple la meta p50 < 15 ms con el margen medido. Los 150 ms de espera para el reemplazo no forman parte de la latencia de la ejecución siguiente.

### Carga sostenida

El primer intento completo terminó con **exit shell 139 / `Segmentation fault`**. No produjo stdout, stderr ni ventanas documentadas; se desconoce cuántas ejecuciones completó. Ese resultado se conserva como evidencia de fallo, sin atribuirlo a M4 ni a una causa específica.

Para acotar el problema se ejecutaron 500 casos por configuración tanto antes de M4 (`ca196b8`) como en el estado actual (`a71272c`). Ambas comparaciones completaron; su menor duración impide usarlas para explicar o descartar el crash.

El **segundo intento completo** terminó con **5 000 ejecuciones por configuración**, cada una con **4 500 OK, 250 throw y 250 timeout**, **0 resultados inesperados**, **502 workers creados** y `poolClosed: true` [R]. Las cifras siguientes comparan la primera y última ventana de 500 ejecuciones; RSS incluye los workers del mismo proceso; el heap corresponde al hilo padre.

| `maxUses` | RSS inicial → final (bytes) | Ratio RSS | p50 inicial → final (ms) | p95 inicial → final (ms) | Ratio p95 |
|---|---|---:|---|---|---:|
| 100 | 174743552 → 202997760 | 1,16169× | 1,019 → 0,950 | 76,636 → 64,938 | 0,84736× |
| 1 000 | 205574144 → 210403328 | 1,02349× | 0,896 → 0,942 | 67,474 → 75,986 | 1,12615× |

Ninguna configuración de la corrida completa posterior activó las alertas de RSS o p95. **M6 queda DONE por su aceptación de reporte**, con corrida completa y fallo previo documentados; no es un cierre del crash ni una declaración de estabilidad validada. El gate M6 separado, `npm run test:all`, terminó con exit 0: **145 JS + 1 prueba de paquete + 2 Python + typecheck + `check:dist`**.

El criterio del soak es informativo: alerta si RSS final / inicial supera 1,5 o p95 final / inicial supera 2. Sus resultados no sustituyen una auditoría del módulo WASM ni determinan el tamaño óptimo del pool.
