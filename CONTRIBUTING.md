# Cómo trabajamos en Code Dope

## Rama y commits

- Parte del SHA vigente y abre una rama por cambio coherente; no hagas push directo, force-push ni borres `main`.
- Un commit debe tener un propósito verificable. Usa `tipo(área): resultado` (p. ej. `fix(core): conserva recibos parciales`). Incluye el porqué si no se desprende del cambio.
- Revisa el diff y ejecuta `bash scripts/check-secrets.sh staged` antes de subir. No subas claves, archivos de entorno, rutas privadas, artefactos de máquina ni evidencia con datos sensibles. El chequeo requiere Gitleaks y no imprime hallazgos.

## Pull request y merge

- Abre el PR como borrador mientras falten pruebas o revisión. Completa [la plantilla](.github/PULL_REQUEST_TEMPLATE.md) con alcance, límites, procedencia y evidencia del SHA evaluado.
- Antes de fusionar, verifica de nuevo el HEAD, que esté al día con la base, la CI del candidato, la ausencia de conversaciones sin resolver y los hallazgos de revisión. Una prueba verde no autoriza el merge.
- El mantenedor autoriza explícitamente cada merge. Preferimos squash para un cambio coherente; no activar auto-merge. No publicar paquetes, conectar servicios ni modificar permisos como consecuencia de un merge.
- GitHub reportó que el plan actual no habilita protecciones ni rulesets en este repositorio privado. Hasta poder activarlos, los checks corren como evidencia y estas reglas son manuales: GitHub no bloquea por sí mismo pushes directos ni merges que las incumplan.

## Cuando GitHub permita hacer obligatorio el control

Aplicar a la rama predeterminada: PR obligatorio, conversaciones resueltas, rama actualizada y checks `package`, `Secrets and private paths` y `Documentation links and references`. Bloquear force-push y eliminación de `main`, también para administradores. No exigir una aprobación de GitHub que el autor único no pueda emitir: conservar la autorización humana de merge y ajustar la revisión cuando exista un revisor independiente. Confirmar los nombres desde una corrida completada antes de marcarlos como obligatorios; luego leer la regla y comprobar que esté activa. No usar bypass ni cambiar visibilidad para activarla.

Referencias: [pr-gate de Design Skills Router](https://github.com/fegome90-cmd/design-skills-router/rules/27632531) · [Plantilla de origen](https://github.com/fegome90-cmd/design-skills-router/blob/5e812588e15d1ae2aed94263b64675d237a18bd9/.github/PULL_REQUEST_TEMPLATE.md).
