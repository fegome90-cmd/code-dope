# ARCHITECTURE

## Principio

Reutilizar primero y escribir solo lo que falta. Este es el único código nuevo de cierto tamaño:

```
                       ┌──────────────── code-dope ─────────────────┐
 modelo ── code ──▶ MCP │ createCodeModeMcpServer  (src/mcp.ts)      │
                        │   └─ codeMcpServer  ◀── @cloudflare/codemode/mcp (reutilizado)
                        │ createSearchExecuteMcpServer (discovery.ts)│
 plugin ── code ──▶     │ createCodeRunner (runner.ts)               │
                        │          │                                 │
                        │   withPolicy(executor, policy)  policy.ts  │  ← allowlist, aprobación,
                        │          │                                 │    validación, presupuesto,
                        │   WorkerExecutor → worker thread efímero   │    timeout, auditoría
                        │     (env vacío, heap limitado, kill duro)  │
                        │     └ QuickJSExecutor: WASM sin fs/red/    │
                        │       process/timers                       │
                        │     puente único: strings JSON             │
                        │     preludes: sandbox/helpers.js           │
                        └──────────┼─────────────────────────────────┘
                                   ▼
                     funciones host (credenciales aquí) → upstream MCP / APIs
```

## Componentes seleccionados (de los 9 candidatos del ancla)

| Candidato | Decisión | Dónde |
|---|---|---|
| Tool Discovery | Sí: búsqueda léxica + tipos por subconjunto. Reduce 24× el tamaño de `listTools` con 83 herramientas [R] | `discovery.ts` |
| Schema / Interface | Reutilizado: generador de Cloudflare vendorizado | `vendor/cf-json-schema-types.ts` |
| Tool Composition | Sí, como helpers dentro del sandbox, no como framework | `sandbox/helpers.js` |
| Execution | Solo para Node, donde no existía. Worker por defecto, después de la revisión S3 | `executor/` |
| MCP Adapters | Envoltorio de unas 20 líneas sobre `codeMcpServer` + servidor search/execute | `mcp.ts`, `discovery.ts` |
| Policies | Sí, como decorador del `Executor` | `policy.ts` |
| Observability | Mínima: registros de auditoría y logs capturados. Sin OTel, porque nada lo requiere hoy | `policy.ts` |
| Recipes | 3 builders parametrizados | `recipes.ts` |
| Templates | Los ejemplos funcionan como plantilla, sin generador | `examples/` |

## Decisiones

1. **TypeScript como lenguaje principal.** Los consumidores (SDK de MCP, `@cloudflare/codemode`, plugins JS) son TS/JS. Python queda solo como snippet para Claude PTC.
2. **La policy es un decorador del `Executor`, no del servidor.** Así se aplica por igual con `codeMcpServer`, con search/execute, con `createCodeRunner` y con cualquier otro executor que cumpla el contrato (incluido `DynamicWorkerExecutor` en Workers). El código del guest solo alcanza las funciones ya envueltas, por lo que no puede saltarse la policy. Los `connectors` de Cloudflare (RPC directo) se rechazan, porque sí la saltarían.
3. **Fail-closed por defecto.** Una herramienta sin clasificar se deniega, y una escritura sin hook `approve` también.
4. **Puente solo de strings JSON.** Ningún handle de objeto del host entra al guest: no existe una cadena `constructor` que lleve al realm del host.
5. **Worker thread por ejecución (por defecto).** La revisión independiente mostró que, en modo inline, un bucle de CPU congela el event loop y un desbordamiento de stack podía dejar inservible el módulo WASM. El worker resuelve ambas cosas a cambio de unos 100 ms por ejecución. El modo inline sigue disponible y recicla el módulo cuando detecta un fallo de limpieza.
6. **Pool de workers opt-in (Fase 2).** `PooledWorkerExecutor` reutiliza el worker y su módulo WASM cargado, nunca el estado del guest: cada ejecución crea runtime y contexto QuickJS nuevos. Reciclaje conservador: cualquier ejecución con error (incluido un `throw` normal), timeout, crash o salida descarta el worker; también al llegar a `maxUses` éxitos (default 100) y tras `idleMs` ocioso (default 30 s). Los mensajes llevan `job` id y el worker descarta las respuestas de llamadas abandonadas de jobs anteriores. El timeout duro cubre el arranque del worker. No es el default porque deja hilos vivos y agrega `close()` al ciclo de vida. Sin `stderr: true` (ese stream retiene el proceso aun con `unref`): el worker del pool silencia su propio stderr. Medido: ~4,7 ms p50 en caliente contra ~94 ms del efímero.
7. **Sin replay ni aprobación durable.** El motor de Cloudflare depende de Durable Objects. La aprobación aquí es síncrona por llamada y recibe los argumentos reales.

## Portabilidad

| Código | Requiere |
|---|---|
| `src/sandbox/helpers.js`, recipes generadas | cualquier sandbox Code Mode JS (Node con QuickJSExecutor, Cloudflare Workers, iframe). Sin imports |
| `snippets/ptc_helpers.py` | Claude PTC (`code_execution_20260120`+) o cualquier Python asyncio |
| `policy.ts`, `discovery.ts#searchTools` | cualquier runtime JS (sin APIs de Node, salvo `setTimeout`) |
| `executor/`, `runner.ts`, `helpers.ts` | Node ≥ 22.18 (type stripping; `readFileSync`) |
| `mcp.ts`, `discovery.ts#createSearchExecuteMcpServer` | Node + `@modelcontextprotocol/sdk` ^1.25 + zod 4 |
| Proveedor concreto | ninguno obligatorio. Cloudflare se usa como biblioteca, no como plataforma |

Un plugin de ChatGPT, Claude Code y un servidor MCP independiente **no** tienen las mismas capacidades. Un servidor MCP en Node usa `mcp.ts`. Un plugin JS con herramientas propias usa `runner.ts`. Un host con Code Mode nativo usa solo helpers y recipes.
