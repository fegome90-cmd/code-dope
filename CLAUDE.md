# code-dope — instrucciones para agentes

- Empieza por el último `HANDOFF-*.md` y por `catalog/patterns.json`. Lee otros archivos solo si el handoff los nombra.
- Node ≥ 22.18, TypeScript sin build en desarrollo (type stripping): imports relativos con extensión `.ts`, `import type` para tipos, sin `enum` ni `namespace`.
- Después de cambiar `src/`, corre `npm run build` y commitea `dist/` junto con las fuentes; `test:all` verifica su deriva con `check:dist`. No edites `dist/` a mano. TypeScript está fijado en 5.9.3; la distribución usa JavaScript compilado y no tiene `prepare`.
- Antes de cerrar cualquier cambio: `npm run test:all` en verde. No debilites `tests/review-regressions.test.ts` ni `tests/executor.test.ts`.
- Seguridad (no negociable): nunca `node:vm`, `eval` ni `new Function` en el host para código del modelo. La policy es fail-closed. Las credenciales solo viven en funciones host.
- Reutiliza antes de escribir: `@cloudflare/codemode/mcp` es dependencia; `src/vendor/` es MIT copiado, no lo edites salvo para sincronizar con upstream.
- Nuevo helper → `src/sandbox/helpers.js` (sin imports ni timers). Nueva recipe → `src/recipes.ts` (valida identificadores, parámetros con `JSON.stringify`). Agrega su prueba y su entrada en el catálogo.
- No modificar otros repos, no publicar paquetes, no activar servicios facturables sin autorización.
