# Cómo trabajamos en Code Dope

## Ramas y promoción

| Rama | Uso | Entrada habitual |
| --- | --- | --- |
| `developer` | Integrar trabajo de desarrollo | PR desde `feat/*`, `fix/*` o rama equivalente |
| `tester` | Validar el candidato integrado | PR desde `developer` |
| `main` | Conservar la versión estable | PR desde `tester` y autorización del mantenedor |

El PR #1 es el bootstrap previo a este flujo y conserva su destino `main`. Si el mantenedor lo aprueba y fusiona, sincronizar `developer` y `tester` mediante PR antes de usar el flujo normal. No se promociona ningún cambio automáticamente.

## Commits

- Parte del SHA vigente y abre una rama por cambio coherente. No hagas push directo, force-push ni borres ramas protegidas.
- Un commit debe tener un propósito verificable. Usa `tipo(área): resultado`; explica por qué si no se desprende del cambio.
- Revisa el diff y ejecuta `bash scripts/check-secrets.sh staged` antes de subir. No subas claves, archivos de entorno, rutas privadas, artefactos de máquina ni evidencia con datos sensibles.

## Hooks de pre-commit

Necesitas `uv` 0.13.9 (fijado en `pyproject.toml`) además de Node 24 y pnpm; ejecuta `uv sync` una vez para crear el entorno de tooling. `pnpm install` instala automáticamente `.husky/pre-commit` mediante el script `prepare`. En cada `git commit` se ejecuta, en este orden:

1. `pnpm exec lint-staged`: Biome sobre TS/JS/JSON staged, markdownlint sobre Markdown staged y codespell con la whitelist de `config/codespell-ignore.txt`.
2. `bash scripts/check-secrets.sh staged`: el mismo escaneo de secretos que exige esta guía.
3. `pnpm typecheck`: chequeo de tipos del proyecto completo.

El hook no ejecuta `pnpm test` (es lento y CI ya lo corre) y NO sustituye a CI ni autoriza merge. Si el hook no está instalado (por ejemplo, un clon con hooks desactivados), ejecuta esos tres comandos manualmente antes de subir. `git commit --no-verify` es una excepción explícita: no exime del escaneo de secretos ni de los checks de CI.

## Pull request y merge

- Abre el PR como borrador mientras falten pruebas o revisión. Completa [la plantilla](.github/PULL_REQUEST_TEMPLATE.md) con alcance, límites, procedencia y evidencia del SHA evaluado.
- El [ruleset de GitHub](https://github.com/fegome90-cmd/code-dope/rules/28158227) exige PR, conversaciones resueltas, base actualizada y checks `package`, `Secrets and private paths` y `Documentation links and references` de GitHub Actions. Bloquea force-push y eliminación en las tres ramas, sin bypass.
- El mantenedor autoriza explícitamente cada merge. Para ramas de trabajo preferimos squash; para promociones entre ramas permanentes, un merge commit conserva la ascendencia compartida. No activar auto-merge. CI verde no autoriza publicación, despliegue ni cambios de permisos.
- Comprueba la rama de origen y destino antes de promocionar. La tabla es una regla de trabajo; el ruleset valida PR y checks, no restringe automáticamente la rama de origen.

Referencias: [pr-gate de Design Skills Router](https://github.com/fegome90-cmd/design-skills-router/rules/27632531) · [Plantilla de origen](https://github.com/fegome90-cmd/design-skills-router/blob/5e812588e15d1ae2aed94263b64675d237a18bd9/.github/PULL_REQUEST_TEMPLATE.md).
