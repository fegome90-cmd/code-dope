# Guía de Code Dope

Biblioteca TypeScript/ESM experimental para Code Mode en Node. El paquete sigue con `private: true`; no se autoriza publicarlo. El candidato del PR #2 incorpora las Fases 1–3 de [PLAN.md](PLAN.md), con ejecutores, policy y adaptadores MCP.

## Arquitectura

- `src/`: QuickJS-WASM ejecuta el código guest; las herramientas host se suministran mediante un catálogo explícito y quedan envueltas por una policy fail-closed. Nunca ejecutar código del modelo mediante `node:vm`, `eval` o `new Function` en el host.
- `worker` es el aislamiento por defecto; `pool` e `inline` son opt-in. Importar la biblioteca no crea workers ni servicios. `helpers.ts` lee únicamente el recurso local empaquetado del sandbox.
- Los adaptadores MCP están en el subpath `code-dope/mcp`. No conceder acceso implícito a red, archivos, credenciales ni herramientas; las credenciales viven en funciones host.
- `scripts/` y `.github/workflows/`: consumidor aislado del tarball, deriva del build, pruebas del escaneo staged, controles de secretos y documentación.

## Reglas

- Lee [la hoja de ruta](docs/roadmap.md), [CLAUDE.md](CLAUDE.md) y el último handoff antes de modificar contratos. No declares implementado lo propuesto ni estabilices una API sin consumidores.
- El flujo reproducible es npm con `package-lock.json`: `npm ci && npm run test:all`. CI usa la línea Node de `.node-version` y npm fijado en `packageManager`. No mantener un segundo lockfile o un segundo flujo de bootstrap.
- En cambios de comportamiento prueba positivos, negativos y fallos parciales. No aceptar comparaciones de dos resultados vacíos salvo que sea el resultado esperado y se afirme. No debilitar los tres archivos protegidos de CLAUDE.md ni editar `src/vendor/` salvo parches acotados de seguridad o estabilidad documentados en la cabecera del archivo y en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Después de cambiar `src/`, reconstruye y agrega `dist/` al mismo commit. `check:dist` compara contra el índice y rechaza archivos generados no versionados, incluso si una regla de ignore los ocultaría.
- Sigue [CONTRIBUTING.md](CONTRIBUTING.md) para ramas, revisiones y merge. Evidencia verde no autoriza merge, publicación, despliegue ni cambios de permisos. No reutilices excepciones de otros repositorios.
- Aplica [SECURITY.md](SECURITY.md). Sin secretos ni datos reales en fixtures. Temporales sólo en scratchpad o `mkdtemp(os.tmpdir())`.

Reglas adaptadas de la [Constitución Agéntica v1.1](https://github.com/fegome90-cmd/constitucion-ai/blob/cdb626e0960e88e3be1ce4a1755f5441a1dbe251/constitution/AGENTIC-CONSTITUTION.md), sin copiar excepciones ni decidir una licencia pública para este repo.
