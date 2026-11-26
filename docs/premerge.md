# Verificación antes de fusionar

El V1 consulta GitHub y emite un diagnóstico; **no escribe ni fusiona**. Se usa cerca del merge, no antes de cada edición, commit o borrador. Este CLI se debe ejecutar desde una revisión confiable de `main`, nunca desde el checkout candidato. Para probar un cambio aún no fusionado, usa sólo fixtures o un checkout aislado y revisado del verificador.

```sh
node scripts/premerge/cli.mjs --pr 3 --intent bootstrap
```

Requiere `gh` con acceso de lectura y Node 24. `normal` es el modo predeterminado; la sincronización requiere intención explícita. El PR #2 está excluido durante el piloto y se rechaza antes de consultar GitHub. El CLI no lee autorizaciones del cuerpo del PR ni acepta una bandera para declararse aprobado. Cero sólo significa `READY`; uno significa que la promoción no está lista o falta evidencia, y dos indica uso inválido o PR fuera de alcance.

| Resultado | Próximo paso del agente |
| --- | --- |
| `WAIT_CI` | Esperar el intento identificado, sin disparar otra corrida. Seguir tareas independientes. |
| `STALE` | Releer la identidad y renovar sólo evidencia afectada. |
| `FIX_REQUIRED` | Corregir ruta o fallo concreto y volver a verificar. |
| `BLOCKED_EVIDENCE` | Recuperar evidencia verificable. No inferir que un verde agregado habilita la promoción. |
| `NEEDS_HUMAN` | Solicitar una vez aprobación vigente o revisión independiente, según el motivo. |
| `READY` | El informe está listo; no ejecuta el merge ni reemplaza el ruleset o la aprobación. |

La clave reproducible, cuando hay identidad verificada, permite a quien invoca deduplicar avisos. El CLI no mantiene registros, notificaciones ni polling. Una condición inválida conocida se informa antes de pedir aprobación, aunque haya CI en curso. El panel de GitHub no queda bloqueado por este CLI.

## Arranque y límites

1. Sincronizar `main` → `tester` con el SHA de bootstrap y la base inicial. Revisar CI, diff, árbol y ascendencia, y obtener la autorización del mantenedor para ese PR.
2. Una vez comprobado el resultado, preparar `tester` → `developer` y verificar lo mismo. Ambas sincronizaciones usan merge commit. No se cambian bases ni se promocionan otros PR por arrastre.
3. Inspeccionar el readback al cerrar cada PR: igual contenido y `main` ancestro de `tester`, y `tester` ancestro de `developer`. No omitir checks ni crear excepciones permanentes.

El evaluador puro distingue evidencia técnica de aprobación y puede comprobar un recibo separado que haya verificado un coordinador de confianza. En el V1 el lector vivo no suministra esa aprobación ni certifica por sí solo que la CI se ejecutó sobre el árbol de integración con controles independientes. La ausencia de esa evidencia no puede dar `READY`. Los tres checks nativos siguen aplicándose sin cambios.

[Reglas de contribución](../CONTRIBUTING.md) · [Checks de GitHub](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
