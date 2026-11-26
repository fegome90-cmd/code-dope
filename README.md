# Code Dope

Base de una biblioteca en TypeScript para reutilizar Code Mode en plugins y servidores MCP. Empezamos por un núcleo declarativo: el consumidor define las operaciones autorizadas, el núcleo valida planes y devuelve resultados por paso. No ejecuta código libre ni registra herramientas en caliente.

**Estado: bootstrap.** El paquete privado sólo expone un marcador de arranque para probar su instalación. Todavía no hay ejecutor, API estable, integración nativa en Work ni métricas de ahorro.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

La prueba construye el paquete, inspecciona el tarball e instala ese archivo en un proyecto aislado para comprobar el import y los tipos. No publica nada.

[Hoja de ruta y fuentes](docs/roadmap.md) · [Normas para agentes](AGENTS.md) · [Flujo de contribución](CONTRIBUTING.md)

[Ancla del proyecto](ANCHOR.yaml) · [Glosario](GLOSSARY.md) · [Seguridad](SECURITY.md)

`pyproject.toml` sólo configura Ruff para scripts Python opcionales; no añade un runtime ni dependencias al paquete. El lockfile del proyecto es `pnpm-lock.yaml`.

[Verificador de premerge](docs/premerge.md)
