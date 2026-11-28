# Evidencia del PoC funcional

Fecha: 27 de noviembre de 2026. Base de implementación: `9ea7c8e66e0b8ca7a566c7a43b1801c3e0298759`.
La evidencia original pertenece al carril de investigación. El candidato de
integración incluye además el arreglo de policy `8665e7f`. El
[handoff](../HANDOFF-POC.md) conserva los límites del cierre.

## Resultados ejecutados

La tabla conserva los resultados históricos del 27 de noviembre de 2026.

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| Instalación raíz con `npm ci` | PASS, exit 0, lockfile intacto | [Baseline actual](poc-baseline.json) |
| `sh research/capability-selection/verify.sh` | PASS del procedimiento, exit 0 | [Recibo del coordinador](poc-verification.json) |
| Pruebas nuevas del PoC | 30/30 PASS | 25 integración, 3 CLI y 2 de observación de carga |
| Pruebas originales v3 | 55/55 PASS | Mismos archivos y expectativas |
| Paridad cfworker real con Draft7 de Python | 220/220 PASS | 15 aceptados, 205 rechazados |
| Typecheck PoC y contractual | PASS, ambos exit 0 | TypeScript 5.9.3; PoC contra dependencias reales |
| Regresiones en policy original | FAIL, 0/5 PASS, exit 1 | Cinco fallos identificados, no convertidos en éxito |
| Mismas regresiones en policy actual del núcleo | FAIL, 0/5 PASS, exit 1 | Import real de `src/policy.ts` |
| Copia temporal con parche experimental | 55/55 positivos y 5/5 regresiones PASS | Sin modificar policy ni fixtures originales |
| `npm run test:all` sobre el candidato | PASS, exit 0 | 177 JS, 5 Python, 5 infraestructura, 1 consumidor del paquete, tipos y `dist` |
| Secretos y rutas reservadas del índice | PASS, exit 0 | `bash scripts/check-secrets.sh staged`, Gitleaks 8.30.1 |
| UTF-8, enlaces locales y diff | PASS, exit 0 | 24 documentos y `git diff --cached --check` |
| Revisión independiente y recheck | PASS acotado | [Un P1 reproducido, corregido y revisado de nuevo](review.json) |
| Consumo por agente real | PASS para dos tareas; rechazo nativo esperado | [Solicitudes y resultados completos](agent-consumption.json) |
| Native real | NOT_VERIFIED | Adaptador contractual simulado; ningún host nativo acreditado |

El recibo histórico contabilizaba por separado los cinco fallos del núcleo de
esa fecha. En la base posterior `08c1854` pasaron cuatro de cinco casos.
En el candidato con el arreglo `8665e7f`, el control de la policy actual pasa
**5/5**, incluido `malformed-safeParse`. Si ese control falla, el verificador
completa los pasos restantes y devuelve 1. Los recibos versionados conservan
los resultados históricos.

El typecheck del PoC usa `skipLibCheck: true` y no comprueba todos los internos de
las declaraciones de terceros. El typecheck contractual conserva `skipLibCheck: false`
y el contrato Cloudflare fijado. Ninguno sustituye las pruebas de ejecución.

## Criterios de aceptación

| ID | Estado | Resultado observado |
| --- | --- | --- |
| P01 | PASS | OFF devuelve 13 con la policy actual y una llamada auditada; sin sandbox |
| P02 | PASS | ON devuelve 13 mediante worker y QuickJS reales con el mismo catálogo |
| P03 | PASS acotado | Un agente nuevo descubre y elige direct para una llamada y worker para composición; evidencia separada del resolver |
| P04 | PASS | JSON inválido, campos de autoridad y combinaciones incompatibles se rechazan antes de cargar ejecución local |
| P05 | PASS | Native ausente devuelve UNAVAILABLE, sin fallback |
| P06 | PASS | Pool instalado pero no concedido devuelve DENIED; AUTO no amplía un modo obligatorio OFF |
| P07 | PASS | Direct y worker deniegan escritura sin aprobación; cero llamadas host de escritura |
| P08 | PASS con límite declarado | Observación real de módulos, WASM y threads; la fábrica carga constructores de las tres rutas locales |
| P09 | PASS | Mismos inputs y versiones conservan el mismo plan; el recibo usa la revisión efectiva del dispatch |
| P10 | PASS | Revocación mientras carga el adaptador impide invocar la herramienta |
| P11 | PASS | Timeout de escritura produce unknown y una sola invocación; no hay retry automático |
| P12 | PASS | Auditoría local y host con telemetría mínima; fallos de sinks, executor y cleanup preservan evidencia |
| P13 | PASS | Las dos rutas mantienen colisiones, nombres exactos y validación de la policy |
| P14 | PASS | El validador instalado supera los 220 casos del esquema sin otro guard de forma de producción |
| P15 | PASS | Suites originales y gates generales pasan; pruebas protegidas y núcleo intactos |

Los conteos describen los casos ejecutados, no una cobertura exhaustiva ni una
certificación de seguridad. P03 acredita este consumidor sintético de CLI en
esta sesión. No acredita todos los agentes, hosts o plugins.

## Observación de carga

[lazy-loading.test.mjs](../tests/poc/lazy-loading.test.mjs) ejecuta cada escenario
en un proceso nuevo. [observe-loads.mjs](../tests/poc/observe-loads.mjs) registra
source cargado, construcción real de Workers y APIs de WebAssembly. Sus wrappers
delegan a las implementaciones originales y viven sólo en fixtures de prueba.

| Camino | Módulos locales de ejecución | Workers | WASM de QuickJS |
| --- | --- | --- | --- |
| Import, resolve y OFF | 0 | 0 | 0 |
| Native simulado, configuración inválida y rechazo de ruta | 0 | 0 | 0 |
| Fábrica local y constructor de worker, sin execute | Constructores de ejecutores cargados | 0 | 0 |
| Worker real | Carga observada en padre y thread | 1 | Inicialización observada en el thread, ninguna en el padre |

Amaro, usado por Node para quitar tipos TypeScript, tiene su propio WASM. Se
distingue por procedencia del stack y no se contabiliza como QuickJS. La prueba
no cuenta cada objeto interno QuickJSRuntime, no acredita ausencia de dependencias
instaladas y no mide memoria, rendimiento ni aislamiento de sistema operativo.

## Métodos y revisión

Se recuperaron instrucciones reales de Superpowers 7.0.1, pstack
0.15.15-chatgpt.10 y Hardening Loop 0.1.2. EGM se recuperó de la fuente
`google/elephant-goldfish-model`, commit `46933754e63c0424daa9c270d7e0734245d79560`.
No se instaló un runtime MCP de esos métodos. Un worker implementó el PoC; el
coordinador reejecutó su verificación y los gates, y otro agente consumió el CLI.

Los ciclos RED → GREEN incluyeron pérdida de auditoría ante fallo nativo,
recibo obsoleto, fallo de cleanup del pool y mensaje de error vacío. La revisión
independiente del diff completo encontró además una carrera: retirar o reemplazar
el adaptador native durante una escritura iniciada perdía el recibo o atribuía
metadatos del reemplazo. Se reprodujo en RED, se capturó el adaptador invocado y se
añadió una regresión para ambos casos. Otro revisor con contexto nuevo confirmó
GREEN y terminó sin hallazgos materiales pendientes.

El [recibo de revisión](review.json) conserva alcance, comandos, resultados y
hashes finales. Los logs brutos permanecen fuera de Git por contener rutas de
máquina. No se declara FULL_EVAL ni diversidad de modelos; un contexto de
conversación nuevo no implica aislamiento del sistema de archivos.

## Límites que permanecen

- El resultado 5/5 de la policy actual cubre sólo estos casos fail-closed; no
  acredita aptitud para producción ni reemplaza la revisión del mantenedor.
- Native real, OpenCode y UTCP permanecen NOT_VERIFIED en esta etapa.
- Los presupuestos de policy son por ejecución. No existe un presupuesto de tarea
  acumulado entre llamadas directas independientes.
- Una escritura iniciada puede terminar después del timeout. La auditoría unknown
  no indica cancelación confirmada.
- Pool conserva el riesgo nativo histórico y no recibe validación de carga sostenida.
- El entrypoint raíz no cambia. La ausencia de carga demostrada corresponde a la
  API estrecha de este PoC, no a todos los imports actuales del paquete.

El STOP GATE se cumple con el candidato funcional y su evidencia. La siguiente
etapa requiere revisión del mantenedor; no se autoriza merge, promoción o publicación.
