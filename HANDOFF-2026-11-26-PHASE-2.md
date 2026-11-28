HANDOFF — code-dope — Fase 2 (pool de workers)
Fecha: 2026-11-26 · Rama: `claude/lucid-gates-g2l07h` (basada en `feat/code-mode-library` @ `1ff56c5`) · PR: ninguno abierto

## Estado
DONE. `PooledWorkerExecutor` opt-in (`isolation: "pool"`). `npm run test:all` en verde: 71 JS (51 previos + 20 nuevos) + 2 Python + typecheck. Regresiones C1/H3 intactas y sin modificar.

## Qué se construyó
* `src/executor/pool-executor.ts`: `PooledWorkerExecutor` (contrato `Executor`). Opciones: las de `WorkerExecutor` + `size` (2), `maxUses` (100), `idleMs` (30 000; 0 = nunca), `prewarm` (true). `stats` y `close()`.
* `src/executor/worker-bridge.ts`: puente padre compartido (extraído de `WorkerExecutor`, mismo comportamiento).
* `src/executor/worker-entry.ts`: modo `once` (efímero, como antes) y modo `pool` (precalienta el WASM, avisa `ready`, procesa jobs por mensaje).
* `createDefaultExecutor("pool")` (sobrecarga que devuelve `PooledWorkerExecutor`); `isolation: "pool"` disponible en `createCodeRunner`, `createCodeModeMcpServer`, `createSearchExecuteMcpServer`. Default sigue siendo `"worker"`.
* Pruebas: `tests/pool-contract.test.ts` (15, escritas por Sonnet sin ver la implementación) y `tests/pool.test.ts` (5, implementación) + `tests/fixtures/pool-unclosed.ts`.
* Bench: caso `candidatePoolWarm` y p95 en `bench/RESULTS.json`.

## Decisiones (acordadas con el usuario)
1. Opt-in, no default: deja hilos vivos y agrega `close()`.
2. Reciclar ante **cualquier** ejecución con error (incluido un `throw` normal), timeout, crash o salida. Un error de herramienta capturado por el guest no recicla (la ejecución termina sin error).
3. Tope `maxUses` y cierre de ociosos por `idleMs`.
4. Meta de rendimiento: medir y reportar. Medido: p50 ~4,7 ms / p95 ~6,8 ms en caliente, contra ~94 / ~125 ms del efímero e ~4 / ~5,6 ms inline.

Detalles de diseño: mensajes con `job` id (se descartan respuestas tardías de llamadas abandonadas); el timeout duro cubre también el arranque del worker; la cola FIFO no tiene límite (cada job ocupado está acotado por timeout + gracia).

## Hallazgo
`stderr: true` en un `Worker` retiene el proceso aun tras `worker.unref()` (reproducido). El pool no captura stderr; el worker del pool silencia su propio `process.stderr.write` (ruido de emscripten). Probado en `tests/pool.test.ts` (proceso hijo con pool sin cerrar termina y no imprime `Aborted`). `WorkerExecutor` efímero no cambió.

## Riesgos y NOT_VERIFIED
* Un worker reutilizado comparte el módulo WASM entre ejecuciones exitosas. Mitigado con runtime/contexto nuevo por ejecución, reciclaje ante cualquier error y `maxUses`; no auditado. Para código hostil sigue valiendo: contenedor.
* Silenciar stderr en el worker del pool oculta también mensajes legítimos que el worker escriba ahí (los errores del worker siguen llegando por el evento `error`).
* Los workers heredan `execArgv` del padre (igual que el efímero); flags como `--input-type` rompen el arranque.
* NOT_VERIFIED: comportamiento bajo carga sostenida/larga duración (fugas por `maxUses` alto), `size` óptimo.

## Siguiente fase (opciones del handoff de Fase 1 que siguen abiertas)
Mergear PR #2 (+ esta rama), evaluación con modelo real (requiere API key y autorización), aprobaciones diferidas, integración en consumidor real (otro repo, requiere autorización).
