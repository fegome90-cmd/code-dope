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

## Pull request y merge

- Abre el PR como borrador mientras falten pruebas o revisión. Completa [la plantilla](.github/PULL_REQUEST_TEMPLATE.md) con alcance, límites, procedencia y evidencia del SHA evaluado.
- El [ruleset de GitHub](https://github.com/fegome90-cmd/code-dope/rules/28158227) exige PR, conversaciones resueltas, base actualizada y checks `package`, `Secrets and private paths` y `Documentation links and references` de GitHub Actions. Bloquea force-push y eliminación en las tres ramas, sin bypass.
- El mantenedor autoriza explícitamente cada merge. Para ramas de trabajo preferimos squash; para promociones entre ramas permanentes, un merge commit conserva la ascendencia compartida. No activar auto-merge. CI verde no autoriza publicación, despliegue ni cambios de permisos.
- Comprueba la rama de origen y destino antes de promocionar. La tabla es una regla de trabajo; el ruleset valida PR y checks, no restringe automáticamente la rama de origen.

Referencias: [pr-gate de Design Skills Router](https://github.com/fegome90-cmd/design-skills-router/rules/27632531) · [Plantilla de origen](https://github.com/fegome90-cmd/design-skills-router/blob/5e812588e15d1ae2aed94263b64675d237a18bd9/.github/PULL_REQUEST_TEMPLATE.md).
