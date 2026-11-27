# Cómo trabajamos en Code Dope

## Ramas y promoción

| Rama | Uso | Entrada habitual |
| --- | --- | --- |
| `developer` | Integrar trabajo de desarrollo | PR desde `feat/*`, `fix/*` o rama equivalente |
| `tester` | Validar el candidato integrado | PR desde `developer` |
| `main` | Conservar la versión estable | PR desde `tester` y autorización del mantenedor |

El bootstrap #1 y el arreglo del escáner #4 ya están integrados; las ramas permanentes quedaron sincronizadas tras #5. El PR #2 apunta a `developer`. No se promociona ningún cambio automáticamente.

## Commits

- Parte del SHA vigente y abre una rama por cambio coherente. No hagas push directo, force-push ni borres ramas protegidas.
- Un commit debe tener un propósito verificable. Usa `tipo(área): resultado`; explica por qué si no se desprende del cambio.
- Revisa el diff, ejecuta `npm ci && npm run test:all` y `bash scripts/check-secrets.sh staged` antes de subir. El lockfile es `package-lock.json`; no ejecutar el flujo de bootstrap retirado. No subas claves, archivos de entorno, rutas privadas, artefactos de máquina ni evidencia con datos sensibles.

## Hooks de pre-commit

Necesitas `uv` 0.13.9 y `gitleaks` en el PATH, además de npm 11.19.1. Node 24 es la línea de CI y del hook (`.node-version`); `engines` declara 22.18 como mínimo soportado por la librería. La distribución no incluye el script `prepare` (lo verifica `tests/package.test.ts`), así que instala el hook una vez por checkout con `bash scripts/install-hooks.sh`: preserva cualquier `core.hooksPath` previo en la configuración local compartida y aplica el override sólo a este worktree. El script habilita `extensions.worktreeConfig` en la configuración compartida; es un cambio duradero y necesario para que el override por worktree funcione. En cada `git commit` se ejecuta:

1. `npm exec lint-staged`: Biome sobre código/JSON staged, `npm run typecheck:staged` sobre TS/TSX staged (typecheck más la guarda del índice), `npm run typecheck` cuando se stagea `tsconfig*.json`, markdownlint sobre Markdown staged y codespell con la whitelist de `config/codespell-ignore.txt`.
2. `bash scripts/check-secrets.sh staged`: el mismo escaneo de secretos que exige esta guía.

El typecheck vive dentro de lint-staged a propósito: corre mientras los cambios no staged están ocultos, así un archivo corregido en disco pero no stageado no puede disimular un error de tipos en el commit. Se dispara también cuando se stagea `tsconfig*.json`, y `scripts/check-staged-imports.mjs` rechaza imports relativos que sólo resuelven en el disco y no están en el índice. El hook no garantiza un checkout limpio completo: eso lo cubre `npm run test:all` en CI.

Las excepciones de los linters están acotadas y documentadas: Biome no aplica el formatter ni ocho reglas porque el codebase existente no está formateado; markdownlint desactiva dieciséis reglas por la documentación histórica; la whitelist de codespell contiene palabras españolas válidas. No se agregaron nuevas exclusiones sin una razón verificable en este repo. El hook no ejecuta `npm run test:all` (es lento y CI ya lo corre) y NO sustituye a CI ni autoriza merge. Si el hook no está instalado, ejecuta esos dos comandos manualmente antes de subir. `git commit --no-verify` es una excepción explícita: no exime del escaneo de secretos ni de los checks de CI.

## Pull request y merge

- Abre el PR como borrador mientras falten pruebas o revisión. Completa [la plantilla](.github/PULL_REQUEST_TEMPLATE.md) con alcance, límites, procedencia y evidencia del SHA evaluado.
- El [ruleset de GitHub](https://github.com/fegome90-cmd/code-dope/rules/28158227) exige PR, conversaciones resueltas, base actualizada y checks `package`, `Secrets and private paths` y `Documentation links and references` de GitHub Actions. Bloquea force-push y eliminación en las tres ramas, sin bypass. El job `Config linters` es informativo: no está en la lista de checks exigidos por el ruleset y no lo agregamos sin autorización.
- El mantenedor autoriza explícitamente cada merge. Para ramas de trabajo preferimos squash; para promociones entre ramas permanentes, un merge commit conserva la ascendencia compartida. No activar auto-merge. CI verde no autoriza publicación, despliegue ni cambios de permisos.
- Comprueba la rama de origen y destino antes de promocionar. La tabla es una regla de trabajo; el ruleset valida PR y checks, no restringe automáticamente la rama de origen.

Referencias: [pr-gate de Design Skills Router](https://github.com/fegome90-cmd/design-skills-router/rules/27632531) · [Plantilla de origen](https://github.com/fegome90-cmd/design-skills-router/blob/5e812588e15d1ae2aed94263b64675d237a18bd9/.github/PULL_REQUEST_TEMPLATE.md).
