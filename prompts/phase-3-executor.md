# Prompt: agente ejecutor de la Fase 3 (code-dope)

> Pega todo lo que está debajo de la línea como primer mensaje del agente. Es autocontenido: no depende de la conversación en la que se escribió.

---

Eres el agente que ejecuta la **Fase 3** del repo `fegome90-cmd/code-dope`, una librería de "Code Mode" para Node: código JS escrito por un modelo corre en un sandbox QuickJS-WASM y llama herramientas a través de una policy. El plan ya está **aprobado**. Tu trabajo es implementarlo, no rediseñarlo.

## 1. Fuente de verdad y lectura inicial

Lee en este orden y nada más al principio:
1. `CLAUDE.md`: reglas del repo. Son obligatorias.
2. `PLAN.md`: el plan. Cada mejora (M1–M7) trae diseño, archivos, pruebas, aceptación y riesgos. **Es la especificación.**
3. `HANDOFF-2026-11-26-PHASE-2.md`: estado actual (pool de workers).
4. `catalog/patterns.json`.

Abre otros archivos solo cuando una mejora los nombre. Si `PLAN.md` y este prompt discrepan, gana `PLAN.md`, salvo en las reglas de §3 de este prompt, que ganan siempre.

## 2. Git y PR

- Trabaja sobre `feat/code-mode-library`, que es la rama del PR #2: https://github.com/fegome90-cmd/code-dope/pull/2. Si tu entorno te asigna otra rama de desarrollo, créala desde `origin/feat/code-mode-library`, trabaja allí y, al terminar, avanza `feat/code-mode-library` por fast-forward (`git push origin HEAD:feat/code-mode-library`) **solo si** el merge-base lo permite. Nunca uses force-push ni rebase de commits ya publicados.
- Antes de empezar, verifica que `HEAD` contiene `b7906c4` (commit que confirma D1/D2).
- **Un commit por mejora** (`feat:`, `fix:` o `docs:` con el ID, por ejemplo `fix(policy): M1 …`). Haz push después de cada commit, para que el PR muestre el avance.
- No hagas merge del PR, no abras PRs nuevos y no comentes en GitHub. Al final **actualiza la descripción del PR #2** (ver §6).
- Ningún mensaje de commit, comentario ni archivo del repo lleva identificadores de modelo.

## 3. Reglas no negociables

- `npm run test:all` en verde antes de cada commit. Desde M3 en adelante, `test:all` incluye `check:dist` y `test:pkg`.
- **No debilites** `tests/review-regressions.test.ts`, `tests/executor.test.ts` ni `tests/pool-contract.test.ts`: no se borran, no se relajan asserts y no se saltan tests. Si una mejora vuelve incompatible una expectativa (riesgo conocido: `spawned` en el test de `maxUses` de `pool-contract` después de M4), **detente y reporta** en vez de ajustar el test.
- Seguridad (de CLAUDE.md): nunca `node:vm`, `eval` ni `new Function` en el host para código del modelo; la policy es fail-closed; las credenciales viven solo en funciones host. No edites `src/vendor/`.
- No modifiques otros repos, no publiques paquetes, no actives servicios facturables y no ejecutes **M8 ni M9**: requieren API key y autorización explícita del usuario.
- Archivos temporales: solo en un directorio de `os.tmpdir()` creado con `mkdtemp`, o en tu scratchpad. Nunca escribas sueltos en el repo ni en `/tmp`.

## 4. Orden y particularidades de cada mejora

Orden: **M1 → M2 → M3 → M4 → M5 → M6 → M7.** Antes de arreglar M1 y M2, **reproduce el fallo** con el script de §5 y deja la salida en tu informe (rojo → verde).

- **M1** (`src/policy.ts`): sigue PLAN §M1. Puntos clave:
  - el campo `closed` se marca en el `finally` de `withPolicy`;
  - la verificación va justo antes de `fn(args)`, después de `approve`;
  - el `AbortSignal` se pasa en `ApprovalRequest`;
  - las llamadas que terminan después del cierre se auditan con `afterExecutionEnd`.
  Verifica en los tres executors (inline, worker y pool).
- **M2** (`src/policy.ts`, `src/discovery.ts:101`, `src/mcp.ts`): D2 = A. Con colisión, las allowlists comparan el nombre exacto y `deny` compara sanitizado. Además:
  - el mensaje de denegación menciona la colisión;
  - los tipos y la descripción anunciados no muestran la variante no permitida.
  H2 y M1 de la Fase 1 deben seguir en verde.
- **Pruebas a ciegas de M1 y M2:** si puedes lanzar subagentes, pide a uno con **Sonnet** que escriba `tests/phase3-security.test.ts` solo a partir de las secciones "Problema", "Diseño" y "Pruebas" de PLAN §M1 y §M2, **sin leer tu implementación**. Lánzalo antes de implementar y en segundo plano. Tú escribes las de implementación. Si no hay subagentes, escríbelas tú antes de implementar y dilo en el informe.
- **M3** (D1 = B, `dist/` commiteado). Hechos ya probados en un prototipo, que no hace falta volver a investigar:
  - Con `tsconfig.build.json` (extiende `tsconfig.json`, `noEmit: false`, `outDir: "dist"`, `rootDir: "src"`, `declaration: true`, `rewriteRelativeImportExtensions: true`, `include: ["src"]`), tsc 5.9.3 emite imports `.js` correctos.
  - tsc **no** reescribe `new URL("./worker-entry.ts", import.meta.url)`. Usa `import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js"`.
  - Hay que copiar `src/sandbox/` a `dist/sandbox/`, porque `helpers.ts` lee `helpers.js` con `readFileSync`.
  - Una instalación del prototipo desde `git+file://` funcionó con npm 10.9.9 y con pnpm 10.28, worker y pool incluidos. Con `prepare`, pnpm falla con `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; por eso **no hay `prepare`**.
  - Fija `typescript` en `5.9.3` exacto para que `check:dist` sea estable. Borra `dist/` antes de cada build.
  - `test:pkg` instala el tarball de `npm pack` en un directorio de `mkdtemp`.
  - **Después de M3, cada commit que toque `src/` debe incluir `dist/` reconstruido** (`npm run build`).
- **M4** (`src/executor/pool-executor.ts`): reemplazo precalentado cuando se recicla un worker, pero no en el reaping por `idleMs`. `stats.warming`. Al terminar, corre `node --test tests/pool-contract.test.ts tests/pool.test.ts` y agrega los casos del bench.
- **M5:** corrección al plan. La cifra "24× con 83 herramientas" **sí** tiene respaldo parcial: `tests/discovery.test.ts:47` usa `bigCatalogServer(80)` (80 sintéticas + 3 reales = 83), imprime el ratio y exige un mínimo de 5×. Mide el ratio real, ajusta ARCHITECTURE.md a la cifra medida y, si es estable, sube el umbral del test a un valor defendible. No hagas una prueba nueva de cero. Las otras cuatro pruebas de M5 sí son nuevas.
- **M6:** `bench/soak.ts`, fuera de `test:all`. Guarda la salida en `bench/SOAK.json`. Es trabajo mecánico: se puede delegar a un subagente Haiku con el diseño de PLAN §M6.
- **M7:** documentación con las cifras **reales** que obtengas: RESEARCH.md (§1, §2.6, §2.13, §4, §5, §8, §9 y la nueva §10), ARCHITECTURE.md, README.md y CLAUDE.md (regla de `dist/`). Agrega `HANDOFF-<fecha>-PHASE-3.md`. Marca cada M de `PLAN.md` como DONE, PARTIAL o BLOCKED.

## 5. Scripts de reproducción para M1 y M2 (deben fallar antes del arreglo)

Guárdalo fuera del repo (scratchpad o `mkdtemp`) y córrelo con `node <archivo>.ts`. Ajusta la ruta de import a la raíz del repo.

```ts
import { WorkerExecutor, withPolicy, createAuditLog } from "<repo>/src/index.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// M1: la aprobación resuelve después del timeout de la ejecución
let writes = 0; const log = createAuditLog();
const ex = withPolicy(new WorkerExecutor({ timeoutMs: 500, killGraceMs: 100 }), { write: ["w"], approve: () => sleep(1200).then(() => true), audit: log.sink });
const r = await ex.execute("async () => codemode.w({})", { w: async () => { writes++; return 1; } });
await sleep(1000);
console.log("M1:", r.error, "| writes:", writes, "| audit:", JSON.stringify(log.records.map((x: any) => [x.decision, x.outcome])));
// antes del arreglo: writes = 1, audit [["allowed","done"]]. Esperado después: writes = 0, decisión denied.
// M2: colisión por puntuación
const called: string[] = [];
const ex2 = withPolicy(new WorkerExecutor(), { read: ["delete_user"] });
const r2 = await ex2.execute("async () => [await codemode['delete-user']({}).catch((e) => e.message), await codemode.delete_user({})]",
  { "delete-user": async () => { called.push("delete-user"); return 1; }, delete_user: async () => { called.push("delete_user"); return 2; } });
console.log("M2:", r2.result ?? r2.error, called);
// antes: [1, 2] ['delete-user','delete_user']. Esperado: delete-user denegada con mensaje de colisión; called = ['delete_user'].
```

## 6. Trampas conocidas (no las redescubras)

- `new Worker(..., { stderr: true })` **retiene el proceso** aun después de `worker.unref()`. El pool no captura stderr; su worker silencia `process.stderr.write`.
- Los workers **heredan `execArgv`**. No pruebes con `node --input-type=module -e …`, porque el worker falla al arrancar. Usa archivos fixture.
- En modo inline, un stack overflow imprime `Aborted(Assertion failed…)` en stderr. Es ruido de emscripten y se espera.
- `npm run bench` imprime en stdout. Para actualizar `bench/RESULTS.json`, redirige primero a un archivo temporal y después cópialo.
- Una escritura que vence por timeout *por llamada* puede completarse igual (M3 de la Fase 1, `outcome: "unknown"`). M1 no cambia eso; cierra el caso distinto de llamadas que **empiezan** después del fin.

## 7. Cuándo detenerte y preguntar

Solo si (a) cumplir la aceptación de una M exige debilitar un test protegido, (b) dos lecturas razonables del plan llevan a comportamientos de seguridad distintos, o (c) algo requiere red, credenciales o tocar otro repo. Las decisiones de rutina las tomas tú y las anotas en el informe.

## 8. Cierre

1. Actualiza la descripción del PR #2 (título y cuerpo) para que cubra las Fases 1, 2 y 3: qué incluye, cómo probarlo (`npm ci && npm run test:all`), las cifras del bench y los riesgos y NOT_VERIFIED que quedan. Termina el cuerpo con las líneas de atribución que tu entorno indique para PRs.
2. Informe final en español, breve: por cada M, estado, commit y evidencia (salida de las pruebas y cifras). Qué quedó pendiente. Qué verificaste tú y qué es inferencia. Las salidas de los scripts de §5, antes y después.
