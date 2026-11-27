# Handoff: capability selection PoC

## Resultado y alcance

El PR #13 contiene un PoC ejecutable para descubrir, resolver y ejecutar llamadas
directas o programas mediante el worker real. La API y el CLI están en `poc/`;
el [README](README.md) contiene los comandos y el formato de configuración.

La implementación parte de `9ea7c8e66e0b8ca7a566c7a43b1801c3e0298759`, en
`feat/capability-selection-research` hacia `developer`. Se conserva el PR existente.
Todos los cambios de esta etapa están en `research/capability-selection/`.
No se modifican núcleo, distribución, dependencias de producción, lockfiles o CI.
No hay merge, promoción, publicación ni auto-merge.

## Leer y reproducir

1. [README](README.md): API, CLI, ejemplos y límites.
2. [Evidencia P01–P15](evidence/POC.md) y [recibo reproducible](evidence/poc-verification.json).
3. [Consumo real por agente](evidence/agent-consumption.json), distinto de una matriz del resolver.
4. [RESEARCH.md](RESEARCH.md), Parte IV; las partes anteriores conservan historia.

```bash
npm ci
sh research/capability-selection/verify.sh
npm run test:all
```

Se ejecutaron 30 pruebas nuevas, 55 originales, 220 comparaciones del esquema,
dos typechecks y las pruebas completas del repositorio. El script vuelve a producir
cinco FAIL tanto en la policy baseline como en la policy actual. Sólo la copia
temporal parcheada supera esas cinco regresiones. Ese FAIL permanece explícito.
La revisión independiente encontró una carrera del adaptador native; se corrigió
y otro revisor confirmó el arreglo y la suite, sin hallazgos materiales pendientes.
El [recibo de revisión](evidence/review.json) conserva los hashes y resultados.

## Decisiones que conservar

- El agente pide modo y ruta; el host conserva disponibilidad, permisos, policy,
  aprobaciones y revisión. AUTO no amplía autoridad ni incorpora otro LLM.
- OFF usa el adaptador directo con `withPolicy` y `createAuditLog` del núcleo.
- El runtime local se importa a demanda y se instancia tras revalidar el contexto.
  La fábrica actual importa clases inline y pool aunque la ruta elegida sea worker.
- La ausencia de inicialización se mide por separado de imports y creación de threads.
  El WASM de Amaro no se cuenta como QuickJS.
- No repetir una escritura con resultado desconocido ni tras error de entrega o cleanup.
- `catalog/patterns.json` es documentación reutilizada, no autoridad ni registry nuevo.

## Pendientes para una etapa autorizada posterior

1. Revisar este candidato. El STOP GATE impide continuar por iniciativa propia.
2. Coordinar con el hardening del PR #10 antes de integrar la nueva entrada al núcleo.
   Los cinco retornos malformados de validadores siguen demostrando fail-open.
3. Elegir exports ligeros y comprobar consumo del paquete fuera de este árbol de
   investigación; no prometer hoy instalación o import raíz sin QuickJS.
4. Conectar un host nativo real si existe una necesidad. La simulación actual sólo
   verifica el contrato; el host permanece NOT_VERIFIED.
5. Evaluar otros backends, presupuestos de tarea y estabilidad del pool únicamente
   si la siguiente etapa los requiere. No bloquean la revisión del PoC actual.

La versión semántica y los exports del paquete no cambian en esta entrega.
