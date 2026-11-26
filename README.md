# code-dope — biblioteca reutilizable de Code Mode

Código listo para que agentes, plugins y servidores MCP ejecuten **Code Mode** (el modelo escribe un programa que llama varias herramientas) sin reescribir cada vez el sandbox, las políticas ni los patrones.

- **Nivel 1. Hosts con Code Mode nativo** (Cloudflare, Claude PTC): helpers y recipes que se pegan en el código. Ver `src/sandbox/helpers.js` y `snippets/ptc_helpers.py`.
- **Nivel 2. Plugins y servidores MCP**: `createCodeModeMcpServer`, `createSearchExecuteMcpServer`, `createCodeRunner`, `withPolicy`, recipes.
- **Nivel 3. Hosts sin Code Mode** (Node): `WorkerExecutor` (por defecto: worker thread desechable con QuickJS-WASM dentro), `PooledWorkerExecutor` (`isolation: "pool"`: workers precalentados y reutilizados) y `QuickJSExecutor` (inline). Los tres implementan el contrato `Executor` de `@cloudflare/codemode`.

Para buscar un patrón según la tarea, ver **[`catalog/patterns.json`](catalog/patterns.json)** (índice para agentes).

## Instalación

Node ≥ 22.18. En desarrollo se ejecutan las fuentes TS por type stripping; los consumidores cargan JavaScript y declaraciones desde `dist/`, incluido en Git.

```bash
git clone <este repo>
cd code-dope
npm ci
npm run test:all      # deriva de dist + JS + Python + tipos + instalación del paquete
```

Desde otro proyecto, fija un tag o commit que incluya `dist/`:

```bash
npm install 'git+ssh://git@github.com/fegome90-cmd/code-dope.git#<tag-o-commit>'
```

Importa `code-dope` o `code-dope/mcp`. No hay `prepare` ni compilación al instalar; el paquete no requiere permitir scripts de build en npm, pnpm o Bun. La instalación del tarball con npm se verifica en `test:pkg`; npm y pnpm desde Git tienen evidencia del prototipo D1, y Bun queda pendiente de ejecución directa. La autenticación de Git depende del acceso al repositorio.

Tras modificar `src/`, ejecuta `npm run build` y agrega `src/` y `dist/` al mismo commit. `check:dist` reconstruye con TypeScript 5.9.3 y exige que `dist/` coincida con el índice de Git y no contenga archivos sin versionar; agrega el build actualizado al índice antes de la verificación previa al commit. `test:pkg` instala un tarball en un directorio temporal y prueba inline, worker, pool y consumo TypeScript.

## Uso rápido

### Servidor MCP: envolver un servidor existente en una herramienta `code`

```ts
import { createCodeModeMcpServer } from "code-dope/mcp";
const server = await createCodeModeMcpServer({
  upstream: myMcpServer,                       // McpServer con tus herramientas
  policy: {
    read: ["list_orders", "get_customer"],     // sin efectos
    write: ["update_order"],                   // requieren approve()
    approve: async ({ tool, args }) => askHuman(tool, args),
    maxCalls: 50,
    audit: (r) => log(r),
  },
});
await server.connect(new StdioServerTransport());
```

Con catálogos grandes conviene `createSearchExecuteMcpServer`, que expone `search_tools` + `execute` y solo entrega los tipos de las herramientas encontradas.

### Plugin con herramientas propias (sin MCP)

```ts
import { createCodeRunner, paginatedFilter } from "code-dope";
const runner = createCodeRunner({ tools: { notes: { list_notes, archive_note } },
  policy: { read: ["list_notes"], write: ["archive_note"], approve } });
const r = await runner.run(paginatedFilter.build({ namespace: "notes", listTool: "list_notes", cursorArg: "offset", where: { tag: "ideas" } }));
// r.result, r.error, r.logs, r.audit
```

Ejemplo completo en `examples/plugin-consumer/` (`npm run example:plugin`). Cliente MCP real por stdio en `examples/mcp-client/` (`npm run example:mcp`).

### Dentro del sandbox

```js
async () => {
  const all = await helpers.paginate((cursor) => codemode.list_orders(cursor == null ? {} : { cursor }));
  const res = helpers.settle(await helpers.parallel(ids.map((id) => () => codemode.get_customer({ id }))));
  return helpers.summarize(helpers.pick(helpers.where(all.items, { status: "pending" }), ["id", "total"]));
}
```

## Garantías de seguridad (y sus límites)

- El código del modelo corre en QuickJS-WASM: sin `require`, `process`, `fetch`, fs, timers ni red. Por el puente solo cruzan strings JSON; ningún objeto del host entra al guest. Verificado en `tests/executor.test.ts` y en la revisión independiente.
- Por defecto (`isolation: "worker"`) cada ejecución usa un worker thread nuevo, con `env` vacío y límite de heap V8. Un bucle de CPU no bloquea el host y un watchdog puede terminar el worker. `isolation: "pool"` reutiliza workers precalentados (p50 2,74 ms en este bench): cada ejecución recibe un runtime y contexto QuickJS nuevos, pero comparte el módulo WASM cargado. El worker se descarta tras **cualquier** ejecución con error y tras `maxUses` (100) usos. Con `prewarm: true`, el reemplazo comienza a calentarse al reciclar; `stats.warming` cuenta los slots todavía sin señal de disponibilidad. El reaping por `idleMs` no crea reemplazos. Los workers ociosos no retienen el proceso; `close()` detiene el pool. `isolation: "inline"` midió p50 2,44 ms, pero un bucle bloquea el event loop hasta el deadline.
- Límites: timeout de reloj (incluye la espera de herramientas), interrupción de CPU, memoria, stack, logs, llamadas en vuelo y tamaño y profundidad del resultado.
- La policy envuelve las funciones host **antes** de que el sandbox las vea, así que el código no puede saltarse la allowlist, las aprobaciones, la validación ni el presupuesto. Es fail-closed: una herramienta sin clasificar se deniega, y una escritura sin `approve` también. Sin colisión, los nombres se comparan sanitizados (`delete-user` = `delete_user`). Si coexisten variantes con el mismo sanitizado, `read`, `write` y `validate` requieren el nombre exacto: `"*"` no sustituye esa clasificación explícita. `deny` sigue denegando todas las variantes sanitizadas. Ambos servidores MCP omiten de los tipos y la descripción las variantes que colisionan y no están permitidas; las admitidas se anuncian por su nombre exacto. Un nombre sin proveedor aplica a todos los proveedores; usa `proveedor.tool` para acotarlo. Los hooks reciben una copia de los argumentos. Si una llamada vence por timeout, su efecto puede igual completarse (queda auditada como `outcome: "unknown"`), así que las herramientas de escritura deberían ser idempotentes.
- `withPolicy` cierra los permisos al terminar `execute`, tanto en inline como en worker y pool: una aprobación tardía no puede iniciar una herramienta. El aprobador recibe `signal`, que se aborta al cierre. Las llamadas que ya empezaron pueden completarse; si su registro se emite después del cierre lleva `afterExecutionEnd: true`. `guardFns` usado por separado no conoce ese ciclo de vida y sus guards permanecen abiertos.
- Las credenciales viven solo en las funciones host.
- **Límites:** QuickJS-emscripten no está auditado (lo dice su propio autor). Un worker thread comparte proceso con el host, así que no es un límite de SO. El primer intento de carga sostenida terminó con un **fallo nativo del proceso (`Segmentation fault`, exit 139)**; un segundo intento completó la carga, pero la causa sigue sin determinarse. Para código hostil, ejecuta el servidor además en un proceso o contenedor de bajo privilegio. El texto que devuelven las herramientas puede traer prompt injection: la descripción de la herramienta lo advierte al modelo, pero no se filtra. Evidencia y límites en [RESEARCH.md](RESEARCH.md) §5 y §8 y [bench/SOAK.json](bench/SOAK.json).

## Benchmark (`npm run bench`, datos sintéticos, MCP en memoria)

Workflow: pedidos `pending` de clientes `gold` → ids, totales y suma. 20 corridas por caso, Node v24.22.3. Resultados en [bench/RESULTS.json](bench/RESULTS.json).

| Métrica | Baseline (llamadas individuales) | Code Mode | Tipo |
|---|---|---|---|
| Invocaciones a herramientas | 5 | 5 | medido |
| Caracteres de resultados que llegan al modelo | 4 402 | 854 | medido |
| Caracteres de definiciones de herramientas | 928 | 2 436 | medido |
| Resultado correcto | sí | sí | medido |
| Ante un fallo (cliente no disponible) | error al modelo + 1 turno extra | resultado parcial + lista de fallos, en la misma llamada | medido |
| Turnos del modelo | 6 (secuencial) / 4 (tool use paralelo) | 2 | derivado (script) |
| Contexto acumulado estimado (incluye el código candidato) | 25 470 chars | 6 447 chars | estimación |
| Tokens reales y latencia del modelo | — | — | **NOT_VERIFIED** |

| Ejecutor / condición | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Baseline: llamadas individuales | 0,43 | 0,91 |
| Worker efímero | 61,53 | 87,29 |
| Pool caliente | 2,74 | 5,88 |
| Pool tras error, con 150 ms de margen para el reemplazo | 6,07 | 7,94 |
| Pool en frío, `prewarm: false` | 50,92 | 53,81 |
| Inline | 2,44 | 4,64 |

El margen de 150 ms del caso tras error queda fuera del intervalo medido. El caso frío crea un pool nuevo por muestra e incluye el arranque en `execute`. Las cifras describen esta máquina y esta carga; no son una promesa de latencia. Code Mode mantuvo las 5 llamadas externas y redujo el volumen enviado al modelo. El ahorro de turnos se deriva del script; tokens reales, tiempo del modelo y calidad del código generado siguen **NOT_VERIFIED**.

El test existente de discovery, con 83 herramientas, midió 39 816 → 1 709 caracteres de `listTools`: **23,30×**, estable en tres corridas y con umbral de regresión de 20×. No es una medición de tokens.

### Carga sostenida (`node bench/soak.ts`)

Este bench es informativo y queda fuera de `test:all`. El segundo intento completó 5 000 ejecuciones por configuración, pool de tamaño 2, con 90 % OK, 5 % throw y 5 % timeout. Cada configuración terminó con 0 resultados inesperados y 502 workers creados. Las métricas completas y el primer intento fallido quedan en [bench/SOAK.json](bench/SOAK.json).

| `maxUses` | RSS final / primer tramo | p95 final / primer tramo | Alertas de tendencia |
|---|---:|---:|---|
| 100 | 1,162× | 0,847× | Ninguna |
| 1 000 | 1,023× | 1,126× | Ninguna |

Los umbrales son RSS > 1,5× o p95 > 2×. El primer intento terminó con exit 139 antes de emitir una ventana de 500; su número de ejecuciones completadas es desconocido. Las comparaciones de 500 por configuración antes y después de M4 también pasaron, sin identificar la causa del crash. El reintento exitoso no demuestra estabilidad general. Los errores reciclan workers con frecuencia, por lo que esta mezcla tampoco valida 1 000 usos consecutivos exitosos por worker.

## Estructura

```
src/executor/                      nivel 3: WorkerExecutor (default), PooledWorkerExecutor (pool), QuickJSExecutor (inline)
src/policy.ts                      allowlist, aprobación, validación, presupuesto, auditoría
src/runner.ts                      entrada para plugins
src/mcp.ts                         adaptador MCP (reutiliza codeMcpServer de Cloudflare)
src/discovery.ts                   search_tools + execute, ranking léxico
src/sandbox/helpers.js             helpers del sandbox (JS puro)
src/recipes.ts                     workflows parametrizados
src/vendor/                        código MIT copiado de cloudflare/agents
snippets/ptc_helpers.py            helpers para Claude Programmatic Tool Calling
catalog/patterns.json              índice de patrones por tarea
examples/  tests/  bench/
```

Cómo ampliar: agrega un helper en `src/sandbox/helpers.js` (sin imports ni timers) o una recipe en `src/recipes.ts` (valida identificadores e incrusta parámetros con `JSON.stringify`). Después agrega una prueba y una entrada en `catalog/patterns.json`.

Documentos: [RESEARCH.md](RESEARCH.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
