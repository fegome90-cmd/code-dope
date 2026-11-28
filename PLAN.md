# PLAN — Fase 3: bloqueos de la revisión del 2026-11-26

Origen: revisión previa con 4 subagentes (3 verificando referencias externas y 1 contrastando RESEARCH.md con el código). Los hallazgos técnicos T1–T3 fueron reproducidos por el implementador. La ejecución de esta fase utilizó tres subagentes adicionales; ver RESEARCH.md §9.
Estado: **APROBADO** (2026-11-26). Decisiones confirmadas por el usuario: **D1 = B** (`dist/` commiteado con verificación de deriva) y **D2 = A** (allowlists exactas cuando hay colisión, `deny` sanitizado). Ejecución: **M1–M7 DONE**; M8 y M9 **BLOCKED**, fuera del alcance autorizado. M6 cumple su aceptación informativa, con un crash nativo pendiente de investigar. Evidencia y desviaciones de proceso en `HANDOFF-2026-11-26-PHASE-3.md`.

Reglas comunes a todas las mejoras:
- Cada una cierra con `npm run test:all` en verde y un commit propio en `claude/lucid-gates-g2l07h`.
- No se debilitan `tests/review-regressions.test.ts`, `tests/executor.test.ts` ni `tests/pool-contract.test.ts`.
- Las pruebas de regresión de seguridad (M1, M2) las escribe un subagente independiente desde la especificación de esta página, sin ver el arreglo. Las de implementación las escribe el agente principal. Se usaron subagentes de Codex por instrucción posterior del usuario.

| ID | Mejora | Tipo | Prioridad | Depende de | Decisión | Estado / commit |
|---|---|---|---|---|---|---|
| M1 | Cortar escrituras después del fin de la ejecución | técnico / seguridad | 1 | — | — | DONE · `84fc495` |
| M2 | Colisión de nombres por puntuación | técnico / seguridad | 1 | — | D2 = A ✔ | DONE · `cbdb7da` |
| M3 | Instalable como dependencia (`dist/` commiteado) | técnico / bloqueante | 1 | — | D1 = B ✔ | DONE · `ca196b8` |
| M4 | Reemplazo precalentado en el pool | rendimiento | 2 | — | — | DONE · `1e3fcd0` |
| M5 | Respaldar afirmaciones [R] sin prueba | verificación | 2 | — | — | DONE · `a71272c` |
| M6 | Bench de carga sostenida del pool | verificación | 2 | M4 | — | DONE · `facff98`; crash pendiente |
| M7 | Actualizar RESEARCH / ARCHITECTURE / README | documentación | 3 | M1–M6 | — | DONE · este commit |
| M8 | Verificar capacidad PTC vía Models API | externo | — | autorización | API key | BLOCKED · NOT_RUN |
| M9 | Evaluación con modelo real | externo | — | autorización | API key + costo | BLOCKED · NOT_RUN |

Los diseños aprobados siguientes se conservan como especificación; las notas de estado describen su ejecución. La causa del primer fallo nativo del soak sigue abierta, aunque su reintento completo no activó alertas de tendencia.

---

## M1. Cortar escrituras después del fin de la ejecución

**Estado de ejecución: DONE.**

**Problema (reproducido).** El host sigue ejecutando una llamada después de que la ejecución terminó. Con `approve` asíncrono más lento que el timeout de la ejecución, el caller recibe `Execution timed out` y, después, la herramienta de escritura se ejecuta igual, con la auditoría en `allowed / done`. Pasa en `WorkerExecutor`, `PooledWorkerExecutor` e inline, porque el wrapper de policy es el mismo. Las llamadas lanzadas sin `await` sufren lo mismo.

**Diseño.**
1. `withPolicy` crea por ejecución `state = { calls, seq, closed: false, abort: new AbortController() }` y envuelve `inner.execute` en `try/finally`. En el `finally` pone `closed = true` y llama a `abort.abort()`.
2. `guardFns` revisa `state.closed`:
   - al entrar, antes de reservar el cupo;
   - **justo antes de `fn(args)`**, después de `approve` y del validador.
   Si está cerrada, `release()` y `deny("execution already finished")`.
3. `ApprovalRequest` gana `signal: AbortSignal` (opcional para quien lo implemente). La firma no cambia de forma incompatible.
4. Una llamada que ya entró a `fn` no se puede cancelar (riesgo M3 existente). Si termina después del cierre, el registro de auditoría agrega `afterExecutionEnd: true`. `AuditRecord` gana ese campo opcional.
5. `guardFns` exportada sin `state` sigue funcionando: el estado por defecto nunca se cierra. Se documenta.

**Archivos.** `src/policy.ts`. Tipos en `src/index.ts` (sin export nuevo salvo el tipo). README §garantías.

**Pruebas (revisor independiente, a ciegas).**
- Un `approve` que tarda más que `timeoutMs` no produce ninguna llamada a la herramienta, ni durante ni después; la auditoría lo registra como `denied` con esa razón. Se prueba con worker, pool e inline.
- Una llamada sin `await` y con `approve` lento, en una ejecución que retorna enseguida, no ejecuta la escritura.
- El `signal` llega abortado al aprobador cuando la ejecución termina.
- Una herramienta de lectura en curso al cerrarse se audita con `afterExecutionEnd: true`.
- Regresión: H1 (cupo con aprobación concurrente) sigue en verde.

**Aceptación.** Después de que `execute` resuelve, no se invoca ninguna herramienta, sin excepción.
**Riesgos.** Una carrera entre la revisión previa a `fn` y el cierre en el mismo tick; es aceptable porque el cierre ocurre en un `finally` asíncrono posterior. Hay que verificar que las ejecuciones normales no se cierren antes de tiempo con herramientas legítimas en vuelo: el executor ya espera a que termine el guest.
**Esfuerzo.** Bajo, unas 40 líneas. El agente principal implementa y el revisor independiente prueba.

---

## M2. Colisión de nombres por puntuación

**Estado de ejecución: DONE.**

**Problema (reproducido).** `read: ["delete_user"]` también autoriza `delete-user` cuando ambas herramientas existen, porque `matches()` compara nombres sanitizados. `src/discovery.ts:101` (visibilidad en `search_tools`) tiene la misma lógica.

**Diseño (D2 = A, confirmado).**
1. Nueva función pura `collisions(names: string[]): Set<string>` con los nombres reales cuyo sanitizado es compartido.
2. `matches(list, provider, tool, { exact })`: si `tool` está en una colisión, las listas `read`, `write` y `validate` comparan solo el nombre exacto (con o sin `proveedor.`). `deny` siempre compara sanitizado, porque denegar de más es fail-closed.
3. `guardFns` calcula las colisiones una vez por proveedor. `discovery.ts` reutiliza la misma función para su filtro `g()`.
4. Sin colisión, el comportamiento no cambia, así que H2 y M1 de la Fase 1 siguen igual.
5. **Mensaje explícito.** Cuando una herramienta que colisiona termina sin clasificar, la razón de denegación lo dice: `"<tool>" collides with "<other>" after sanitization; name it exactly in the policy`.
6. **Tipos sin duplicados.** `createCodeModeMcpServer` y `createSearchExecuteMcpServer` excluyen de los tipos y de la descripción anunciada al modelo las variantes que colisionan y no están permitidas. Si las dos están permitidas, se anuncian por su nombre exacto (acceso `codemode["delete-user"]`), no por el alias sanitizado ambiguo.

**Descartadas.** B (denegar u ocultar siempre las que colisionan) pierde herramientas legítimas. C (rechazar la ejecución completa, como `DynamicWorkerExecutor` de Cloudflare) inutiliza al proveedor entero.

**Archivos.** `src/policy.ts`, `src/discovery.ts`. La documentación de `ToolPolicy` explica la regla.

**Pruebas (revisor independiente, a ciegas).**
- Con `delete_user` y `delete-user` presentes y `read: ["delete_user"]`, solo se ejecuta `delete_user`; `delete-user` termina en `not classified`.
- `deny: ["delete-user"]` con colisión deniega las dos variantes.
- Sin colisión, `deny: ["delete-user"]` deniega `delete_user` (H2).
- `search_tools` no muestra la variante no permitida.
- La razón de denegación menciona la colisión.
- La descripción y los tipos de `createCodeModeMcpServer` no contienen declaraciones duplicadas ni la variante no permitida.
- Se cubren los tres executors y los dos servidores MCP.

**Aceptación.** Ninguna allowlist autoriza un nombre real distinto del escrito cuando hay ambigüedad.
**Esfuerzo.** Bajo. El agente principal implementa y el revisor independiente prueba.

---

## M3. Instalable como dependencia (`dist/` commiteado)

**Estado de ejecución: DONE.**

**Problema (reproducido).** Node no hace type stripping bajo `node_modules`: `import "code-dope"` falla con `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. El camino de instalación del README no funciona.

**Decisión (D1 = B, confirmada).** `dist/` se commitea y no hay script `prepare`. Motivo, probado con un prototipo: la opción `prepare` falla por defecto en pnpm 10 (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) y, según la documentación, también en Bun. `dist/` commiteado funcionó en npm, en npm con `--ignore-scripts` y en pnpm, con worker y pool.

**Diseño.**
1. `tsconfig.build.json`: extiende `tsconfig.json` con `noEmit: false`, `outDir: "dist"`, `rootDir: "src"`, `declaration: true`, `rewriteRelativeImportExtensions: true` e `include: ["src"]`. Probado con TS 5.9.3.
2. Script `build`: `tsc -p tsconfig.build.json`, más la copia de `src/sandbox/` a `dist/sandbox/` (`helpers.js` se lee en runtime con `readFileSync`). Se borra `dist/` antes de compilar para que no queden archivos huérfanos.
3. `WORKER_ENTRY` en `src/executor/worker-executor.ts`: elige `./worker-entry.ts` o `./worker-entry.js` según `import.meta.url`. tsc no reescribe `new URL(...)`; probado en el prototipo.
4. `package.json`:
   - `exports` con `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }, "./mcp": { … } }`;
   - `files: ["dist", "snippets", "catalog", "THIRD_PARTY_NOTICES.md", "README.md"]`;
   - sin `prepare`.
   En el repo, los tests, examples y bench siguen importando `src/*.ts` por ruta relativa, así que el desarrollo sigue sin build.
5. **Verificación de deriva:** script `check:dist` (`npm run build && node scripts/check-dist.mjs`) incluido en `test:all`. Si alguien cambia `src/` sin reconstruir, `test:all` falla. También rechaza archivos generados que no están en el índice, incluso si Git los ignora; la regresión usa un índice temporal real.
6. `.gitattributes`: `dist/** linguist-generated=true -diff`, para que los diffs y las revisiones de PR no se inflen.
7. CLAUDE.md:
   - "sin build en desarrollo; después de cambiar `src/` corre `npm run build` y commitea `dist/` (lo verifica `test:all`)";
   - "no edites `dist/` a mano".
   README: instalación (`npm install git+ssh://…#<tag o commit>`, compatible con npm, pnpm y Bun sin configuración extra).

**Variante futura B′.** `dist/` solo en tags de release. No entra en esta fase.

**Pruebas.**
- `tests/package.test.ts`: `npm pack` del repo, instalación del `.tgz` en un directorio temporal (`os.tmpdir()` + `mkdtemp`), y un consumidor que importa `code-dope` y `code-dope/mcp` y corre `createCodeRunner` en worker y en pool. Es lenta (~10 s), así que va en el script `test:pkg`, incluido en `test:all`.
- Los `.d.ts` pasan un typecheck en el consumidor.
- La instalación desde `git+file://` con pnpm se probó manualmente en el prototipo. No entra en `test:all` porque requiere descargar pnpm.

**Aceptación.** Un proyecto externo instala desde git o desde el tarball con npm o pnpm, sin flags ni allowlists, y ejecuta código en los tres modos. `test:all` falla si `dist/` está desfasado.
**Riesgos.** Que la salida de tsc varíe entre máquinas y la verificación de deriva dé falsos positivos: se mitiga fijando la versión de `typescript` en devDependencies (hoy `^5.9.0`; fijar `5.9.3`). Diffs duplicados en cada cambio a `src/`.
**Esfuerzo.** Medio. El agente principal implementa.

---

## M4. Reemplazo precalentado en el pool

**Estado de ejecución: DONE.**

**Problema (medido por el revisor).** Después de un error, la siguiente ejecución cuesta ~100 ms, porque el reemplazo se crea en el camino crítico. La primera llamada tras construir el pool también puede salir en frío.

**Diseño.**
1. `#destroy()`: si `!closed && prewarm && slots.size < size`, lanza de inmediato un reemplazo (`#park(#spawn())`) en vez de esperar a la siguiente `execute`. No aplica al reaping por `idleMs`, que sí debe reducir el pool.
2. `#acquire()`: prefiere un worker ocioso **ya listo**. Si solo hay workers arrancando, toma el que lleva más tiempo arrancando, en vez de crear otro.
3. `stats` agrega `warming` (workers aún no listos).

**Pruebas (implementador).**
- Después de un error, `stats.alive === size` sin llamar a `execute`.
- El reaping por `idleMs` sigue dejando `alive === 0`.
- Las pruebas de contrato de la Fase 2 siguen en verde; en particular, `spawned` con `maxUses`, que podría cambiar de valor.

**Bench.** Agregar los casos "pool, primera ejecución después de un error" y "pool en frío". El README separa los tres.
**Aceptación.** La primera ejecución después de un error, con al menos 100 ms de margen, tiene p50 < 15 ms. Si no se cumple, se reporta igual.
**Esfuerzo.** Bajo.

---

## M5. Respaldar afirmaciones [R] sin prueba

**Estado de ejecución: DONE.**

| Afirmación | Acción |
|---|---|
| El modo inline bloquea el event loop (RESEARCH §5) | Prueba: 0 o muy pocos ticks durante un `for(;;)` inline, como contraparte de H3. |
| `unwrap` y la rama `toolResult` (L5) | Prueba unitaria de `discovery.ts` con un upstream que devuelve `toolResult`. |
| Con un heap grande, el GC hace que el timeout llegue antes del error de memoria (§5) | Prueba no frágil: con `memoryLimitBytes` alto y una asignación masiva, `error` matchea `/out of memory|timed out/`. Se documenta como no determinista. |
| "24× menos `listTools` con 83 herramientas" (ARCHITECTURE) | Origen encontrado: `tests/discovery.test.ts:47` (`bigCatalogServer(80)`, 80 + 3 = 83 herramientas) imprime el ratio y exige ≥ 5×. Medir el ratio real, poner esa cifra en ARCHITECTURE y subir el umbral del test a un valor estable. |
| El entry raíz de Cloudflare no carga en Node (§2.1) | Prueba: `import("@cloudflare/codemode")` rechaza con `/cloudflare:/`. Avisa si upstream lo arregla. |

**Esfuerzo.** Bajo. Lo hace el agente principal.

---

## M6. Bench de carga sostenida del pool

**Estado de ejecución: DONE.**

**Diseño.** `bench/soak.ts`, no incluido en `test:all`: unas 5 000 ejecuciones con mezcla de 90 % OK, 5 % throw y 5 % timeout corto, en un pool de tamaño 2 con `maxUses` 100 y 1 000. Mide RSS y heap del padre en cada tramo de 500, la latencia p50/p95 por tramo y `spawned`. Salida en `bench/SOAK.json`.
**Aceptación.** Solo se reporta. Se marca alerta si el RSS crece más de un 50 % entre el primer y el último tramo, o si el p95 se degrada más de 2×.
**Dependencia.** M4, para no medir la latencia de respawn ya corregida.
**Esfuerzo.** Bajo. Se puede delegar como trabajo mecánico, con el diseño ya fijado.

---

## M7. Actualizar la documentación

**Estado de ejecución: DONE.**

- **RESEARCH.md:**
  - §1: `@cloudflare/codemode` 0.5.6 sigue siendo la última (publicada el 2026-10-29); `code_execution_20260521` es la versión vigente, con 90 s por celda; la CLI de UTCP es 0.1.1; quickjs-emscripten 0.32.0 sigue siendo la última (2026-02-16).
  - §2.6: `openApiMcpServer` (`./mcp`) ofrece search + execute en Node.
  - §2.13: falta en la documentación la frase "`allowed_callers` no es un límite de seguridad"; queda como [I]. Agregar las restricciones de PTC: no admite herramientas de conectores MCP, `strict: true` ni `tool_choice` forzado.
  - §4 y §8: el advisory de isolated-vm pasa de [H] a confirmado por fuentes secundarias (crítico, corregido en 6.2.0 y 7.0.1); PTC del modelo objetivo queda confirmado por la documentación, pendiente M8.
  - §5: el pool y su riesgo (módulo WASM reutilizado).
  - §9: los 4 subagentes de esta revisión.
  - §10 nuevo: Fase 2 y Fase 3.
- **ARCHITECTURE.md:** diagrama con el pool y una sección de distribución (`dist/` commiteado, verificación de deriva).
- **README.md:** tabla de bench separando caliente, tras error y en frío; instalación (M3); garantías (M1, M2).
- **Handoff:** `HANDOFF-…-PHASE-3.md`.

**Esfuerzo.** Bajo. Lo integra el agente principal al final, con los números reales.

---

## M8. PTC del modelo objetivo vía Models API (externo)

**Estado de ejecución: BLOCKED — NOT_RUN.**

El objetivo se mantiene según la versión aprobada de este plan (`b7906c4`). Una llamada `GET /v1/models/<modelo-objetivo>` para leer `capabilities.code_execution`. Requiere una API key en la sesión (vía `request_credential`) y tu autorización. Su costo es nulo o despreciable. Resultado: cierra RESEARCH §8.

## M9. Evaluación con modelo real (externo)

**Estado de ejecución: BLOCKED — NOT_RUN.**

Fuera del alcance de esta fase, salvo que lo autorices. Su diseño y presupuesto requieren una tarea posterior. Requiere API key y un presupuesto de gasto.

---

## Decisiones (investigadas y confirmadas el 2026-11-26)

### D1: cómo distribuir el build

Se probó un prototipo en un clon temporal: `tsc` con `rewriteRelativeImportExtensions` y `WORKER_ENTRY` condicionado a la extensión. Consumidor instalando desde `git+file://` [R]:

| Opción | npm 10.9.9 | npm `--ignore-scripts` | pnpm 10.28 (default) |
|---|---|---|---|
| A: `prepare` construye `dist/` (no commiteado) | OK (8 s, sin devDeps en el consumidor) | OK (npm ejecutó `prepare` igual) | **FALLA**: `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; el consumidor debe ponerlo en su allowlist |
| B: `dist/` commiteado, sin `prepare` | OK | OK | OK |

En los casos OK funcionaron el worker y el pool desde `dist/`.

Documentación verificada por el revisor: Bun no ejecuta scripts de dependencias que no estén en `trustedDependencies`, y Yarn Berry usa `prepack` en vez de `prepare` para dependencias git [O doc, no probado]. Node rechaza a propósito el type stripping en `node_modules` y recomienda publicar JS [O doc].

**Confirmada: B**, con una verificación de deriva en `test:all` (`npm run build && node scripts/check-dist.mjs`) para que `dist/` no quede desfasado de `src/`. Funciona con cualquier gestor sin configuración del consumidor. El costo son diffs duplicados en cada cambio.

Variante B′: `dist/` solo en tags de release, generado por un script, con los consumidores fijados a `#vX.Y.Z`. Deja `main` limpio, pero exige disciplina de release. Se puede adoptar más adelante.

### D2: colisión de nombres por puntuación

Evidencia:
- La especificación MCP dice que los nombres son case-sensitive y SHOULD ser únicos por servidor, y no define una forma sanitizada; la colisión la crea el cliente [O doc].
- `DynamicWorkerExecutor` de Cloudflare **rechaza la ejecución completa** si dos nombres colapsan (`index.js:372-390`) [O, revisor].
- `generateTypes` de Cloudflare no detecta la colisión y emitiría declaraciones duplicadas [I].
- Nuestro `QuickJSExecutor` ya prioriza el nombre exacto y descarta los alias ambiguos [O].

| Opción | Seguridad | Utilidad | Coherencia |
|---|---|---|---|
| A: allowlists exactas cuando hay colisión; `deny` sanitizado | fail-closed: la variante no escrita queda sin clasificar | las dos herramientas siguen disponibles si se nombran exactamente | igual que el executor (exacto primero) |
| B: denegar u ocultar las que colisionan | máxima | pierde ambas herramientas | simple |
| C: rechazar la ejecución completa (como Cloudflare) | máxima, y ruidosa | inutiliza al proveedor entero | idéntica al upstream |

**Confirmada: A**, con dos agregados:
1. La razón de denegación menciona la colisión ("`delete-user` collides with `delete_user`; name it exactly"), para que se entienda el `not classified`.
2. `createCodeModeMcpServer` y el servidor search/execute omiten de los tipos anunciados las variantes no permitidas, para que el modelo no vea declaraciones duplicadas.

B y C protegen igual, pero castigan un caso legítimo, y C inutiliza todo el proveedor.

## Orden de ejecución

M1 → M2 → M3 → M4 → M5 → M6 → M7. M8 y M9 solo con autorización. Un commit por mejora.
