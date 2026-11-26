# Guía de Code Dope

Librería privada TypeScript/ESM. Hoy el paquete expone sólo un marcador de bootstrap: no hay ejecutor, adaptador MCP ni API estable.

## Arquitectura

- `src/`: núcleo sin dependencias de ejecución, sin I/O al importar y sin acoplamiento a proveedor o transporte. El consumidor suministra un catálogo explícito; el núcleo validará planes acotados y conservará estado y procedencia por paso.
- Los adaptadores se añaden fuera del núcleo y son opt-in. No ejecutes código o shell arbitrarios, ni concedas acceso implícito a red, archivos, credenciales o herramientas.
- `scripts/` y `.github/workflows/`: prueba del tarball en un consumidor aislado y controles de secretos y documentación.

## Reglas

- Lee [la hoja de ruta](docs/roadmap.md) antes de modificar contratos. Define alcance y aceptación; no declares implementado lo que sólo está propuesto. No diseñes una API estable sin consumidores.
- Corre `pnpm typecheck` y `pnpm test`. En un cambio de comportamiento prueba positivos, negativos y fallos parciales. La comparación no puede pasar por dos resultados vacíos salvo que el vacío sea lo esperado y se afirme.
- Trabaja en rama y sigue [CONTRIBUTING.md](CONTRIBUTING.md) para commits, PR y merge. Evidencia verde no autoriza mezclar ramas, publicar ni cambiar permisos. No reutilices excepciones de otros repositorios.
- Aplica [SECURITY.md](SECURITY.md). No guardes secretos ni uses evidencia con datos reales para las pruebas iniciales.

Reglas adaptadas de la [Constitución Agéntica v1.1](https://github.com/fegome90-cmd/constitucion-ai/blob/cdb626e0960e88e3be1ce4a1755f5441a1dbe251/constitution/AGENTIC-CONSTITUTION.md), sin copiar sus excepciones ni asignar una licencia pública.
