# code-dope — biblioteca reutilizable de Code Mode

Código listo para que agentes, plugins y servidores MCP ejecuten **Code Mode** (el modelo escribe un programa que llama varias herramientas) sin reescribir cada vez el sandbox, las políticas ni los patrones.

- **Nivel 1. Hosts con Code Mode nativo** (Cloudflare, Claude PTC): helpers y recipes que se pegan en el código. Ver `src/sandbox/helpers.js` y `snippets/ptc_helpers.py`.
- **Nivel 2. Plugins y servidores MCP**: `createCodeModeMcpServer`, `createSearchExecuteMcpServer`, `createCodeRunner`, `withPolicy`, recipes.
- **Nivel 3. Hosts sin Code Mode** (Node): `WorkerExecutor` (por defecto: worker thread desechable con QuickJS-WASM dentro), `PooledWorkerExecutor` (`isolation: "pool"`: workers precalentados y reutilizados) y `QuickJSExecutor` (inline). Los tres implementan el contrato `Executor` de `@cloudflare/codemode`.

Para buscar un patrón según la tarea, ver **[`catalog/patterns.json`](catalog/patterns.json)** (índice para agentes).

## Instalación

Node ≥ 22.18 (el TS se ejecuta por type stripping, sin build).

```bash
git clone <este repo> && cd code-dope && npm install
npm run test:all      # tests JS + tests Python + typecheck
```

Desde otro proyecto: `npm install git+ssh://git@github.com/fegome90-cmd/code-dope.git` e importar `code-dope` o `code-dope/mcp` (el repo es privado).

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
- Por defecto (`isolation: "worker"`) cada ejecución usa un worker thread nuevo, con `env` vacío y límite de heap V8. Un bucle de CPU no bloquea el host, el timeout termina el worker de forma dura y cualquier estado WASM dañado muere con él. `isolation: "pool"` mantiene ese aislamiento pero reutiliza workers precalentados (~5 ms por ejecución en caliente): cada ejecución recibe un runtime y contexto QuickJS nuevos, y el worker se descarta tras **cualquier** ejecución con error y tras `maxUses` (100) éxitos. Los workers ociosos no retienen el proceso; `close()` detiene el pool. `isolation: "inline"` también cuesta ~5 ms, pero un bucle bloquea el event loop hasta el deadline.
- Límites: timeout de reloj (incluye la espera de herramientas), interrupción de CPU, memoria, stack, logs, llamadas en vuelo y tamaño y profundidad del resultado.
- La policy envuelve las funciones host **antes** de que el sandbox las vea, así que el código no puede saltarse la allowlist, las aprobaciones, la validación ni el presupuesto. Es fail-closed: una herramienta sin clasificar se deniega, y una escritura sin `approve` también. Los nombres se comparan sanitizados (`delete-user` = `delete_user`). Un nombre sin proveedor aplica a todos los proveedores; usa `proveedor.tool` para acotarlo. Los hooks reciben una copia de los argumentos. Si una llamada vence por timeout, su efecto puede igual completarse (queda auditada como `outcome: "unknown"`), así que las herramientas de escritura deberían ser idempotentes.
- `withPolicy` cierra los permisos al terminar `execute`, tanto en inline como en worker y pool: una aprobación tardía no puede iniciar una herramienta. El aprobador recibe `signal`, que se aborta al cierre. Las llamadas que ya empezaron pueden completarse; si su registro se emite después del cierre lleva `afterExecutionEnd: true`. `guardFns` usado por separado no conoce ese ciclo de vida y sus guards permanecen abiertos.
- Las credenciales viven solo en las funciones host.
- **Límites:** QuickJS-emscripten no está auditado (lo dice su propio autor). Un worker thread comparte proceso con el host, así que no es un límite de SO. Para código hostil, ejecuta el servidor además en un proceso o contenedor de bajo privilegio. El texto que devuelven las herramientas puede traer prompt injection: la descripción de la herramienta lo advierte al modelo, pero no se filtra. Detalle en RESEARCH.md §5 y §8.

## Benchmark (`npm run bench`, datos sintéticos, MCP en memoria)

Workflow: pedidos `pending` de clientes `gold` → ids, totales y suma. Mediana de 20 corridas. Resultados en `bench/RESULTS.json`.

| Métrica | Baseline (llamadas individuales) | Code Mode | Tipo |
|---|---|---|---|
| Invocaciones a herramientas | 5 | 5 | medido |
| Caracteres de resultados que llegan al modelo | 4 402 | 854 | medido |
| Caracteres de definiciones de herramientas | 928 | 2 479 | medido |
| Tiempo de herramientas + sandbox (mediana) | ~0,5 ms | ~94 ms (worker) / ~4,7 ms (pool en caliente) / ~4 ms (inline); p95: 125 / 6,8 / 5,6 ms | medido |
| Resultado correcto | sí | sí | medido |
| Ante un fallo (cliente no disponible) | error al modelo + 1 turno extra | resultado parcial + lista de fallos, en la misma llamada | medido |
| Turnos del modelo | 6 (secuencial) / 4 (tool use paralelo) | 2 | derivado (script) |
| Contexto acumulado estimado (sin contar la salida del modelo) | ~25 500 chars | ~6 500 chars | estimación |
| Tokens reales y latencia del modelo | — | — | **NOT_VERIFIED** |

Code Mode **no** reduce las llamadas externas: reduce turnos y el volumen que llega al modelo. A cambio cuesta ~100 ms por ejecución con worker efímero (~5 ms con pool en caliente o inline) y una descripción de herramienta más larga. En flujos con modelo real, cada turno ahorrado suele costar mucho más que eso, pero esa latencia es NOT_VERIFIED aquí.

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
