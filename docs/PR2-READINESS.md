# PR #2 — integración y disposición de revisión

Fecha: 2026-11-26. [PR #2](https://github.com/fegome90-cmd/code-dope/pull/2), rama `feat/code-mode-library`, base **`developer`**. Este documento registra la evidencia local y la disposición técnica. La descripción del PR registra el SHA final, los checks remotos de ese SHA y el estado de resolución de los hilos después de publicar. No autoriza merge.

## Integración y controles

| Comprobación | Estado | Evidencia y alcance |
|---|---|---|
| Punto de partida | PASS | HEAD local/remoto `dcd5323b5dac8fb8a9764af063ac183d32573d6f`, worktree limpio y `b7906c4` en su historia. PR originalmente dirigido a `main`, con conflictos y 24 hilos abiertos de 26; dos de esos 24 estaban desactualizados. |
| Base correcta | PASS | PR cambiado a `developer`. Se integró `e0ff96bfe493b70f0abc6a29adb1e360421d9aff` sin reescribir historia. `tester` estaba en `ab09eee` y `main` en `7d2c8d1`; los tres árboles eran idénticos. |
| Integración publicada | PASS | Merge commit `8dcc765b802f212c7be2a62686d52e2926130db2`, padres `dcd5323` y `e0ff96b`. GitHub informó `mergeable: true`. El PR permanece abierto y no fusionado. |
| Ruleset | PASS | [28158227](https://github.com/fegome90-cmd/code-dope/rules/28158227): activo en las tres ramas permanentes, PR y resolución de conversaciones obligatorios, checks estrictos `package`, `Secrets and private paths`, `Documentation links and references`, sin bypass, force-push ni eliminación. No se cambió. |
| Instalación reproducible | PASS | Sólo npm, `packageManager: npm@11.19.1`, `package-lock.json` conservado y `npm ci`. Se retiró el lock pnpm incorporado por bootstrap y su smoke obsoleto. No hay `prepare`. |
| Escaneo del índice de #4 | PASS | `check-secrets.sh`, `scan-staged-secrets.mjs`, su test y `.gitleaks.toml` coinciden byte a byte con la base. Pasaron el escaneo staged y el histórico con Gitleaks 8.30.1 verificado. Se retiraron los dos `.pyc` versionados, sin reescribir el historial ni añadir exclusiones al scanner. |
| CI de integración | PASS | [Run 45830289074](https://github.com/fegome90-cmd/code-dope/actions/runs/45830289074), sólo para `8dcc765`: los tres checks requeridos y `package-windows` terminaron con éxito. Se leyó el log de `package`: corre `npm run test:all`, no el smoke del bootstrap. |
| Gate local del candidato funcional | PASS | `npm ci` y `npm run test:all`: **177 JS, 5 Python, 5 infraestructura, 1 tarball**, typecheck y `check:dist`, cero fallos y saltados. Node v24.22.3, npm 11.19.1, TypeScript 5.9.3. |
| CI del candidato funcional | PASS | [Run 45835034467](https://github.com/fegome90-cmd/code-dope/actions/runs/45835034467) de `cc0597784443d1a64df1c9282e9828c8feafc2d4`: tres checks requeridos y paquete Windows verdes. El merge sintético `9c5fdeead0fbeadb6fcee67ef867c7a436c70dc5` tiene el mismo árbol `57bb67927b0c0ccb72dd26efa939212a3f0dff6c` que el candidato y los revisores evaluaron. El commit posterior de licencia se verifica por separado en la descripción del PR. |
| Integración con sistemas externos | NOT_VERIFIED | Sólo fixtures sintéticos y MCP en memoria/stdio. No se usaron datos reales, credenciales, otros repositorios, modelos de pago ni servicios de producción. |

El mismo workflow ejecuta el gate completo en Ubuntu y un job adicional de distribución en Windows (`check:dist` y `test:pkg`). El job Windows no ejecuta toda la suite funcional. El consumidor del tarball usa una ruta temporal con espacios y llama la CLI JavaScript de npm mediante el ejecutable Node, sin depender de `npm.cmd` ni del shell. Incluye inline, worker, pool e imports/declaraciones de ambos exports.

La distribución se reconstruyó y agregó al índice junto con las fuentes, incluidos `mcp-resources.js` y su declaración. `check:dist` rechaza deriva y archivos generados omitidos aunque estén ignorados por Git. La regresión de infraestructura usa un repositorio temporal real para verificar ambas condiciones.

## Disposición de cada hilo

La columna inicial describe el corte `dcd5323`; “desactualizado” no equivale a resuelto. **PASS** significa que la disposición está respaldada por código y evidencia del candidato. Después de publicar `cc05977` se verificaron **26/26 hilos resueltos, cero abiertos**, y GitHub informó `mergeable: true` y `mergeable_state: clean`; las URLs permiten revisar cada conversación original.

| Hilo | Estado inicial | Disposición | Evidencia específica |
|---|---|---|---|
| [T01](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4707166206) | Abierto, desactualizado | PASS — corregido | El sink de auditoría no altera éxito ni denegación y no genera un falso fallo. `pr2-contracts`: sinks que lanzan y rechazan promesas, escritura exactamente una vez. |
| [T02](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4707166227) | Abierto | PASS — corregido; duplicado de T10 | Python `pick` distingue ausencia de `None` explícito mediante un sentinel. Prueba de ambos casos. |
| [T03](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130626) | Abierto | PASS — corregido | Schema y handler exigen código o recipe conocida, excluyen selección ambigua y capturan errores de build en el envelope. Casos inválidos y código válido en `pr2-contracts`; ejemplo positivo existente conservado. |
| [T04](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130641) | Abierto | PASS — corregido en integración | `check-dist.mjs` detecta nuevos outputs omitidos, incluso ignorados. Regresión en `scripts/check-dist.test.mjs` y PLAN actualizado. |
| [T05](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130655) | Ya resuelto, desactualizado | PASS — cubierto por M3 y vuelto a verificar | Imports JS desde `dist`, sin `prepare`; consumidor del tarball con inline/worker/pool y TypeScript. |
| [T06](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130670) | Abierto | PASS — corregido | README ya no usa `ids` sin definir ni ejecuta `parallel` cuyo resultado se descarta. Ejemplo de paginación y filtrado autocontenido respecto de sus variables. |
| [T07](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130680) | Ya resuelto, desactualizado | PASS — cubierto por M2 y vuelto a verificar | Allowlist exacta ante colisión, deny sanitizado y metadatos sin variante prohibida. Pruebas M2 en tres executors/dos adapters; nueva colisión entre páginas en `pr2-mcp`. |
| [T08](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130693) | Abierto | PASS — corregido | Python `paginate` devuelve `stalled: True` ante cursor repetido. Prueba de dos páginas y cursores terminales `None`/cadena vacía. |
| [T09](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130709) | Abierto | PASS — corregido | Python `retry` no reintenta una denegación. Prueba exige un único intento. |
| [T10](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130721) | Abierto | PASS — corregido; mismo caso que T02 | Se preserva JSON null explícito y se omite una clave ausente. Prueba Python. |
| [T11](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130730) | Abierto | PASS — corregido | Ambos adapters consumen todas las páginas; prueban herramientas tardías, colisión entre páginas, cursor repetido y error de página. También conservan outputSchema y guard de tareas en páginas anteriores. |
| [T12](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130740) | Abierto | PASS — corregido | Ambos adapters cierran pools propios en cierre, desconexión y fallo de inicialización; conservan executors ajenos. Pruebas `pr2-mcp` observan cierre único y ejecución posterior del pool suministrado. |
| [T13](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130745) | Abierto | PASS — corregido | Formatter común limita éxito, error retornado/lanzado y fallo de serialización, con marcador dentro del presupuesto. Pruebas con límites 0, 1, 10 y 1000. |
| [T14](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130755) | Abierto | PASS — corregido | Slot reservado ya muerto/cerrado responde sin instalar watchdog ni invocar herramienta. Test con deadline de 5 s exige respuesta de cierre antes de 500 ms; traza acotada adicional. |
| [T15](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130795) | Abierto | PASS — corregido | Se comprueba el proveedor antes del nombre exacto/sanitizado, también en deny y validate. Pruebas de proveedor distinto con y sin colisión. Los nombres reales con puntos requieren prefijo de proveedor explícito. |
| [T16](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130803) | Abierto, desactualizado | PASS — ya cubierto por M1 y vuelto a verificar | `finally` cierra y aborta; la verificación posterior a approve precede al host call. Pruebas M1 inline/worker/pool de aprobación tardía, llamadas sin await y auditoría tardía conservadas y verdes. |
| [T17](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130824) | Abierto | PASS — corregido | Bulk separa objetivo detenido de no intentados. Test confirma `pending: [3]`, `stopped.id: 2`, outcome unknown y finalización tardía de la escritura 2 sin reintento. |
| [T18](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130839) | Abierto | PASS — corregido | `batch` rechaza 0, negativos, fracciones, Infinity y NaN antes de llamar al callback; chunks válidos preservados. |
| [T19](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130845) | Abierto | PASS — corregido | `retryIf` no puede anular la prohibición de reintentar una denegación. Prueba exige un intento y cero llamadas al predicado; error transitorio sí recupera. |
| [T20](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130851) | Abierto | PASS — corregido | `countBy` usa un objeto sin prototipo. Prueba por recipe conserva `constructor`, `__proto__` y `toString` en el resultado. |
| [T21](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708130861) | Abierto | PASS — corregido | Fixture de proceso hijo usa `fileURLToPath`, no URL.pathname. El contrato de no retener el proceso sigue ejecutándose en `pool.test.ts`. |
| [T22](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708807483) | Abierto | PASS — corregido en integración; duplicado de T04 | Se comprueban outputs sin versionar además del diff de archivos versionados, con prueba real del índice. |
| [T23](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708807499) | Abierto | PASS — corregido | Warmup fallido no genera reemplazos sin demanda. Tres llamadas encoladas reciben error y producen exactamente tres intentos adicionales; no hay crecimiento posterior. |
| [T24](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708807513) | Abierto | PASS — corregido | Construcción conserva una sola conexión upstream y no dispara onclose; herramientas siguen usando el recurso hasta cierre. Un upstream ya conectado se rechaza sin cerrarlo. |
| [T25](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708807527) | Abierto | PASS — corregido | Guard ejecuta snapshot privado previo al await; caller, validador y aprobador reciben objetos distintos. Test muta los tres y exige que la herramienta reciba el valor original autorizado. |
| [T26](https://github.com/fegome90-cmd/code-dope/pull/2#discussion_r4708807539) | Abierto | PASS — corregido en integración | Invocación portable de npm y temporal con espacios. Tarball local verde y job Windows de integración observado; CI del candidato funcional se registra por separado. |

No se descartó ningún hallazgo por estar desactualizado. La observación adicional sobre pérdida de logs guest por terminación/crash se documentó como limitación en README y ARCHITECTURE; no se declara resuelta mediante streaming de logs.

## Revisión independiente

Dos revisores con permisos de sólo lectura recibieron repositorio, baseline `dcd5323`, base `e0ff96b`, integración `8dcc765` y alcance separado. Uno revisó integración, CI y distribución; otro revisó policy, MCP/discovery y ciclo de vida del pool. Revisaron código/diffs y logs; las ejecuciones fueron realizadas por el agente principal. No se confundió lectura de logs con una segunda ejecución independiente.

El revisor de contratos encontró una regresión del SDK al paginar: `Client.listTools()` reemplaza su caché de outputSchema/taskSupport en cada página. Se añadió una prueba antes del arreglo: la ruta discovery falló con structuredContent inválido que no se rechazaba. El helper compartido usa el validador público del SDK y conserva los requisitos de todas las páginas, sin acceder a cachés privadas. Las **32 pruebas dirigidas** posteriores pasaron, incluidas las dos nuevas de metadatos. Esta corrección entró en el gate completo de 177 JS.

## Integridad del baseline

Diff vacío desde el handoff de Fase 3 para `src/vendor/` y los tres tests protegidos. Los SHA-256 siguen siendo:

```text
34d875d18ab40966d0c562824d84e2ea81917dd83375fc1fa2e4eb6a6ea542e9  tests/review-regressions.test.ts
9942acb0434c4de6a901396d5121b49db006bc37097a1268d3e77d3f3c30cd0e  tests/executor.test.ts
d6a01b67eea02e752f86e1117af2bdc1d49c8a5c159cf94c3f832e5f9c047d15  tests/pool-contract.test.ts
```

Se preservaron los commits publicados y el worktree separado de diagnóstico previo. No se eliminaron worktrees ni cambios únicos ajenos. La publicación usa árbol idéntico al verificado y actualización fast-forward del ref del PR con comparación del HEAD esperado; no toca ramas permanentes.

## Gates separados: estabilidad nativa y licencia

**Estabilidad nativa — NOT_VERIFIED.** [SOAK.json](../bench/SOAK.json) y el [handoff de Fase 3](../HANDOFF-2026-11-26-PHASE-3.md) conservan el primer exit 139. El reintento exitoso de 10 000 ejecuciones no identifica una causa ni prueba una corrección. No se repitió ese soak en esta revisión.

Se ejecutó [pool-lifecycle.ts](../bench/pool-lifecycle.ts), fuera de `test:all`, con cinco escenarios controlados: reciclaje exitoso, throw normal y recuperación, herramienta sintética que no resuelve, fallo controlado de warmup y cierre de slot reservado. [POOL-LIFECYCLE.json](../bench/POOL-LIFECYCLE.json) registra **9 workers y 78 eventos**, todos los cierres sin slots vivos y todas las terminaciones observadas completadas. El test adicional de close bloquea artificialmente la promesa de terminate y verifica que todos los callers esperan incluso una terminación que ya salió de `stats.alive`.

Estas pruebas acreditan contratos de ciclo de vida; no contienen una traza nativa del fallo original y no demuestran estabilidad general. **Pool sigue opt-in y el default sigue siendo WorkerExecutor**, comprobado por una regresión explícita. No se necesita cambiar el contrato de default aprobado. Los workers comparten proceso, el stderr del pool se silencia y la cola sigue sin límite. Los timings de esta traza no se usan como benchmark.

**Licencia — PASS por autorización expresa del dueño, 2026-11-26.** Se añadió [LICENSE](../LICENSE) con el texto MIT y copyright «2026 Felipe González», manteniendo `license: "MIT"` en `package.json`. La decisión cierra la discrepancia anterior; no se infirió del metadata. Los notices y el código de terceros permanecen intactos. El paquete sigue con `private: true` y no se autorizó merge, publicación ni despliegue; ver [SECURITY.md](../SECURITY.md).

Los benchmarks de [RESULTS.json](../bench/RESULTS.json) y del soak siguen siendo evidencia histórica de Fase 3. No se presentan como medida del candidato corregido, ahorro de tokens, latencia end-to-end ni estabilidad probada. M8/M9, modelos de pago, publicación, despliegues y merge permanecen fuera del encargo.

## Reproducir la verificación

```bash
npm ci && npm run test:all
node --test tests/pool-contract.test.ts tests/pool.test.ts
node --test tests/pr2-contracts.test.ts tests/pr2-mcp.test.ts tests/pr2-pool.test.ts
node bench/pool-lifecycle.ts
node scripts/check-docs.mjs
bash scripts/check-secrets.sh staged
```

Para actualizar una traza, capturar stdout primero en scratchpad o un directorio creado con `mkdtemp(os.tmpdir())`, revisar la salida y copiar el JSON final. El scanner requiere la versión de Gitleaks y checksum fijados en CI. El stderr `Aborted(Assertion failed…)` de pruebas inline de stack overflow es ruido conocido de Emscripten; no se usa para explicar el exit 139 del soak.
