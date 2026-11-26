# code-dope — instrucciones para agentes

- Empieza por el último `HANDOFF-*.md` y por `catalog/patterns.json`. Lee otros archivos solo si el handoff los nombra.
- Node ≥ 22.18, TypeScript sin build en desarrollo (type stripping): imports relativos con extensión `.ts`, `import type` para tipos, sin `enum` ni `namespace`.
- Después de cambiar `src/`, corre `npm run build` y commitea `dist/` junto con las fuentes; `test:all` verifica su deriva con `check:dist`. No edites `dist/` a mano. TypeScript está fijado en 5.9.3; la distribución usa JavaScript compilado y no tiene `prepare`.
- Antes de cada commit: `npm run test:all` en verde (`check:dist`, pruebas JS, Python, typecheck y `test:pkg`). Agrega el `dist/` reconstruido al índice antes del gate: `check:dist` compara el build con el índice. No debilites `tests/review-regressions.test.ts`, `tests/executor.test.ts` ni `tests/pool-contract.test.ts`: no borrar ni saltar pruebas ni relajar asserts. Si una expectativa protegida impide una mejora, detente y reporta.
- Seguridad (no negociable): nunca `node:vm`, `eval` ni `new Function` en el host para código del modelo. La policy es fail-closed. Las credenciales solo viven en funciones host.
- Reutiliza antes de escribir: `@cloudflare/codemode/mcp` es dependencia; `src/vendor/` es MIT copiado, no lo edites salvo para sincronizar con upstream.
- Nuevo helper → `src/sandbox/helpers.js` (sin imports ni timers). Nueva recipe → `src/recipes.ts` (valida identificadores, parámetros con `JSON.stringify`). Agrega su prueba y su entrada en el catálogo.
- No modificar otros repos, no publicar paquetes, no activar servicios facturables sin autorización.
- Los archivos temporales van solo en el scratchpad o en un directorio de `os.tmpdir()` creado con `mkdtemp`; nunca sueltos en el repo ni en `/tmp`. El soak es informativo, se ejecuta fuera de `test:all` y debe conservar también los intentos fallidos. El primer crash nativo de Fase 3 sigue sin causa identificada.
