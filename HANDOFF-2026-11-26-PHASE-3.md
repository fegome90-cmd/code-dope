# HANDOFF — Fase 3 — 2026-11-26

## Estado y lectura siguiente

**M1–M7 DONE**, con la aceptación informativa de M6 cumplida y un **crash nativo pendiente de investigar**. M8 y M9: **BLOCKED / NOT_RUN**, sin API key, evaluación con modelo real ni gasto. La fase no declara al pool validado para toda carga sostenida.

Lee este documento, `catalog/patterns.json` y `CLAUDE.md`. `PLAN.md` conserva el diseño aprobado y los estados. Para la investigación del crash, los archivos relevantes son `bench/soak.ts`, `bench/SOAK.json`, `src/executor/pool-executor.ts`, `src/executor/worker-entry.ts` y `src/executor/quickjs-executor.ts`. Para usar la biblioteca: `README.md`; para las decisiones y fuentes: `ARCHITECTURE.md` y `RESEARCH.md`.

Se partió de `ba8ad0b`, que contiene `b7906c4` (D1 = B, D2 = A). El trabajo local siguió la rama del PLAN, `claude/lucid-gates-g2l07h`; cada mejora se publicó por avance fast-forward de `feat/code-mode-library`, la rama del [PR #2](https://github.com/fegome90-cmd/code-dope/pull/2). No se hizo merge, rebase ni force-push y no se publicaron comentarios ni paquetes.

## Cambios, commits y gates

Cada fila cerró con `npm run test:all` en verde antes de publicar su commit. Desde M3 incluye `check:dist` y `test:pkg`.

| Mejora | Commit | Evidencia del gate |
|---|---|---|
| M1 | `84fc4954b812790584c502870c4030899b9a2f57` | 89 JS + 2 Python + typecheck |
| M2 | `cbdb7daccc3483977fd93172bd079d733f4ec000` | 137 JS + 2 Python + typecheck |
| M3 | `ca196b8806ddce8f627e843790f0d010cf38fa1b` | 137 JS + 1 paquete + 2 Python + typecheck + deriva |
| M4 | `1e3fcd08abe6b883e823aeebaf122b4dffc47114` | 141 JS + 1 paquete + 2 Python + typecheck + deriva; además 24/24 de pool |
| M5 | `a71272c4d10637c1f7beedcbe984e3e882cb4e8a` | 145 JS + 1 paquete + 2 Python + typecheck + deriva |
| M6 | `facff985d9b9be31492842fb553cf1e0a661c321` | 145 JS + 1 paquete + 2 Python + typecheck + deriva; soak aparte |
| M7 | Este commit | 145 JS + 1 paquete + 2 Python + typecheck + deriva |

Baseline: 71 JS + 2 Python + typecheck. Gate final: **0 fallos, 0 saltados**, en Node **v24.22.3**, npm **11.19.1** y TypeScript **5.9.3**. El mensaje `Aborted(Assertion failed…)` del caso inline de stack overflow es stderr esperado de Emscripten, no un fallo de la suite.

### M1 — cierre de policy

`withPolicy` marca `closed` en `finally` y aborta el `signal` entregado al aprobador. Los guards comprueban el cierre al entrar y justo antes de `fn(args)`, después del validador y la aprobación. Las funciones host que ya comenzaron pueden completarse después; su auditoría incorpora `afterExecutionEnd: true`. Se cubren inline, worker y pool, incluyendo llamadas sin `await`.

`guardFns` usado sin un estado de ejecución conserva guards abiertos. El timeout por llamada sigue pudiendo dejar una escritura con `outcome: "unknown"`; M1 impide que empiece una llamada nueva después del cierre, no cancela un efecto ya iniciado.

### M2 — colisiones

Se detectan nombres reales que comparten sanitizado por proveedor. Ante colisión, `read`, `write` y `validate` exigen el nombre exacto, con o sin proveedor; `deny` siempre compara sanitizado. La denegación explica la colisión. Los tipos y descripciones MCP omiten las variantes ambiguas no permitidas y anuncian las admitidas mediante acceso exacto.

Decisión rutinaria documentada: `"*"` no permite una herramienta ambigua sin clasificarla por nombre exacto. Sin colisión se conserva el comportamiento anterior, incluidos los metadatos de `createCodeModeMcpServer`; las regresiones H2 y M1 de Fase 1 permanecen verdes. La prelectura del catálogo conecta/cierra/reconecta el servidor upstream: el SDK y los fixtures se verificaron, pero los ciclos de vida de servidores externos con recursos propios siguen sin integración real.

### M3 — distribución

`dist/` está en Git, con JS, declaraciones y `sandbox/helpers.js`; no hay `prepare`. El build borra `dist/` y usa TypeScript 5.9.3 exacto. `WORKER_ENTRY` elige `.ts` o `.js` según la URL del módulo. Cada cambio posterior en `src/` incluyó el build.

Se reprodujo deriva de `dist/` con un cambio temporal en fuentes: `check:dist` falló, se restauraron las fuentes y el build volvió a verde. El comando compara contra el índice: agregar el build actualizado antes del gate previo al commit. `test:pkg` instala un tarball real en `mkdtemp`, ejecuta inline/worker/pool y verifica consumo TypeScript. El consumidor usa `skipLibCheck`: verifica la API consumida, no todos los internos declarativos de dependencias.

La instalación npm/pnpm desde `git+file://` es evidencia previa del prototipo D1, no una prueba nueva de esta fase. Bun y el mínimo Node 22.18 no se ejecutaron directamente aquí.

### M4 — reemplazo precalentado

Con `prewarm: true`, el reciclaje inicia el reemplazo y prioriza slots listos. No repone por reaping de `idleMs`, cierre o demanda inexistente con `prewarm: false`. `stats.warming` cuenta slots sin señal de disponibilidad. La prueba protegida de `maxUses` conserva `spawned` sin cambios; el gate dedicado fue `node --test tests/pool-contract.test.ts tests/pool.test.ts`, **24/24**.

### M5 — afirmaciones reproducibles

Cuatro pruebas nuevas en `tests/phase3-evidence.test.ts`: bloqueo inline (0 ticks), rama MCP `toolResult`, asignación masiva con heap de 256 MiB y fallo del entry raíz de Cloudflare por `cloudflare:`. La prueba de memoria observó `out of memory`; permite OOM o timeout porque el orden no es determinista.

Se reutilizó el test de discovery con 80 herramientas sintéticas + 3 reales. Tres corridas midieron **39 816 / 1 709 = 23,30×**; su umbral subió de 5× a **20×**. Mide caracteres del catálogo, no tokens ni llamadas ahorradas.

## Reproducciones de seguridad: rojo → verde

Script del encargo, guardado y ejecutado fuera del repo, antes de implementar M1/M2:

```text
M1: Execution timed out after 500ms (worker terminated) | writes: 1 | audit: [["allowed","done"]]
M2: [ 1, 2 ] [ 'delete-user', 'delete_user' ]
```

Después de M1 y M2:

```text
M1: Execution timed out after 500ms | writes: 0 | audit: [["denied",null]]
M2: [
  'Denied codemode.delete-user: tool is not classified as read or write (fail-closed); "delete-user" collides with "delete_user" after sanitization; name it exactly in the policy',
  2
] [ 'delete_user' ]
```

El `null` en la tupla de auditoría es la serialización JSON del `outcome` ausente de la denegación. `writes = 0` y la llamada exclusiva a `delete_user` son los efectos observados. La suite independiente añade **60 pruebas** (15 de M1 y 45 de M2), escritas desde Problema/Diseño/Pruebas del PLAN antes de revisar la implementación; se agregaron además pruebas propias de implementación.

## Benchmark M4

[bench/RESULTS.json](bench/RESULTS.json): 20 corridas por caso, MCP sintético en memoria, Node v24.22.3.

| Caso | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Baseline | 0,43 | 0,91 |
| Worker efímero | 61,53 | 87,29 |
| Pool caliente | 2,74 | 5,88 |
| Pool tras error, con 150 ms de margen | 6,07 | 7,94 |
| Pool frío, `prewarm: false` | 50,92 | 53,81 |
| Inline | 2,44 | 4,64 |

El margen de 150 ms no entra en la medición tras error. El caso frío crea un pool por muestra e incluye su arranque en `execute`. La meta tras error, p50 < 15 ms, se cumple con esas condiciones.

5 → 5 llamadas externas; 4 402 → 854 caracteres de resultados; 928 → 2 436 caracteres de definiciones. Turnos 6 secuenciales / 4 paralelos → 2 y contexto acumulado 25 470 → 6 447 caracteres son **derivaciones del script**, no medidas de un modelo real. Los 6 447 caracteres incluyen los 721 del código candidato: 2 × 2 436 + 854 + 721. Todas las comprobaciones de resultado del bench pasaron.

## M6 — carga sostenida y crash pendiente

[bench/SOAK.json](bench/SOAK.json) conserva el resultado completo del segundo intento y un historial con el primer fallo y las comparaciones. El script queda fuera de `test:all` (sí se comprueban sus tipos).

- **Primer intento completo:** shell exit **139**, `Segmentation fault`; stdout/stderr vacíos, cero ventanas documentadas. El número de ejecuciones completadas y el cierre del pool son desconocidos.
- **Comparación acotada:** 500 ejecuciones por cada configuración tanto en `ca196b8` (antes de M4) como en `a71272c`. Ambas terminaron sin inesperados. La evidencia no identifica la causa ni permite atribuir el fallo a M4.
- **Segundo intento completo:** 5 000 ejecuciones con `maxUses: 100` y otras 5 000 con `maxUses: 1000`; tamaño 2, dos lanes, 75 ms de timeout y 1 000 ms de gracia. Cada configuración: 4 500 OK, 250 throw, 250 timeout, 0 inesperados, 502 workers creados y `poolClosed: true`. Duración total observada por el supervisor: 50,871 s.

| `maxUses` | RSS primer → último tramo (bytes) | RSS ratio | p50 primer → último (ms) | p95 primer → último (ms) | p95 ratio |
|---|---|---:|---|---|---:|
| 100 | 174743552 → 202997760 | 1,16169× | 1,019 → 0,950 | 76,636 → 64,938 | 0,84736× |
| 1 000 | 205574144 → 210403328 | 1,02349× | 0,896 → 0,942 | 67,474 → 75,986 | 1,12615× |

Sin alertas RSS > 1,5× o p95 > 2× en la corrida completa. RSS incluye workers del mismo proceso; heapUsed/heapTotal miden el hilo padre. Los errores reciclan workers frecuentemente, por lo que la mezcla no valida 1 000 usos exitosos consecutivos. La única modificación del script antes del reintento fue una marca de inicio de configuración en stderr.

**M6 DONE significa reporte solicitado completo. No significa que el crash esté resuelto ni que se haya probado estabilidad general.** La superposición entre terminar un worker y arrancar otro es una hipótesis a investigar, presente también como posibilidad antes de M4; no hay causa demostrada. El stderr silenciado del pool limita el diagnóstico. Una investigación posterior necesitaría trazas de etapas o evidencia nativa, sin cambiar ahora el diseño aprobado.

## Evidencia y límites

Verificado por el agente principal: reproducciones rojo/verde, gates por mejora, instalación del paquete, deriva deliberada, pruebas de contrato, benchmark, soak y conservación de pruebas protegidas. Se utilizaron subagentes de Codex para pruebas independientes, revisión del pool, elaboración del soak y verificación documental; RESEARCH.md §9 distingue el trabajo actual de las revisiones históricas.

M7 verificó fuentes primarias sobre versiones, `openApiMcpServer`, restricciones PTC y el advisory de isolated-vm. El smoke OpenAPI en Node fue ejecutado por el subagente de fuentes con callback sintético. No se llamó a Models API ni a un modelo de pago.

Pendientes / NOT_VERIFIED: causa del crash nativo; aislamiento auditado de QuickJS-WASM; latencia, tokens y calidad de código con modelo real; redes MCP externas; integración en otro repo; Bun y otros entornos; aprobaciones durables/replay; tamaño óptimo del pool. Los workers comparten proceso con el padre, la cola no tiene tope y el texto de herramientas puede contener prompt injection. Una escritura ya iniciada puede completarse tras timeout. Los flags `execArgv` se heredan: usar fixtures, no `node --input-type=module -e` para pruebas con workers.

## Integridad y desviaciones de proceso

Los tres archivos protegidos permanecen byte a byte iguales al baseline, y `src/vendor/` no cambió:

```text
34d875d18ab40966d0c562824d84e2ea81917dd83375fc1fa2e4eb6a6ea542e9  tests/review-regressions.test.ts
9942acb0434c4de6a901396d5121b49db006bc37097a1268d3e77d3f3c30cd0e  tests/executor.test.ts
d6a01b67eea02e752f86e1117af2bdc1d49c8a5c159cf94c3f832e5f9c047d15  tests/pool-contract.test.ts
```

El shell no tenía credenciales para `git push`. Se publicaron los commits mediante el conector GitHub autenticado: árbol remoto idéntico al índice verificado, padre igual al head remoto, y actualización de ref con `expected_sha` y `force: false`. Después se hizo fetch y se verificó igualdad del árbol local/remoto. Es un cambio de transporte, con avance fast-forward y un commit por mejora.

**Desviación formal:** el commit M5 ya publicado usa prefijo `test:`; el encargo pedía `feat:`, `fix:` o `docs:`. Se conserva y se declara para no reescribir historia publicada. Los otros seis commits usan los prefijos indicados. La atribución de agentes se normalizó por rol en la documentación, sin identificadores de modelos.

## Reproducir

```bash
npm ci && npm run test:all
node --test tests/pool-contract.test.ts tests/pool.test.ts
npm run --silent bench
node bench/soak.ts
```

Los benchmarks emiten JSON a stdout. Si se actualizan los JSON del repo, capturar primero en un archivo dentro de `mkdtemp` o scratchpad y copiar solo después de revisar la salida. Conservar cualquier intento fallido. No ejecutar M8/M9 ni gastar en servicios sin autorización específica.
