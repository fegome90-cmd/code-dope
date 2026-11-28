# Capability selection: plan del PoC

## Acuerdo y punto de partida

Implementar y verificar el PoC del PR #13 dentro de `research/capability-selection/`.
El ancla del mantenedor autoriza código, pruebas, commits y actualización del PR.
Merge, promoción, publicación, cambios del núcleo y nuevos backends quedan fuera.
La investigación de la Parte III es el punto de partida; no se reinicia la investigación general.

Preflight realizado el 27 de noviembre de 2026:

- PR #13 abierto y en borrador; origen `feat/capability-selection-research`, destino `developer`.
- HEAD inicial `9ea7c8e66e0b8ca7a566c7a43b1801c3e0298759`; base `0bd8cbc8ed278ad93ac7f5d69c0ccc4cf932b71a`.
- Checkout independiente y limpio al inicio. La copia de otro trabajo quedó intacta.
- Cero conversaciones de revisión; CodeRabbit omitió revisión automática por ser borrador.
- GitHub Actions `Library verification`, run `45991966419`, completado con éxito.
- Ruleset `28158227` activo, sin bypass: PR, conversaciones resueltas, base actualizada y los tres checks documentados.
- Leídos AGENTS, CLAUDE, CONTRIBUTING, SECURITY, ANCHOR, roadmap, handoff, catálogo, plantilla y workflows vigentes.
- Node `24.22.3`, npm `11.19.1`; `npm ci` terminó con código 0, sin modificar el lockfile.

## Modelo y decisión

La solicitud del agente y la autoridad del host tienen propietarios distintos.
El JSON v3 conserva `schemaVersion`, `route` y `telemetry`. La interfaz de ejecución
añade un sobre con modo solicitado y operación. Ese modo sólo puede restringir
las rutas que ya permite el contexto del host; no reemplaza su `mode`, permisos o policy.

Se consideraron dos formas de integrar el PoC:

| Forma | Consecuencia | Decisión |
| --- | --- | --- |
| Usar el entrypoint raíz y `createCodeRunner` para todo | Carga módulos de ejecución en el camino directo y no resuelve su llamada única sin programa | Descartada para OFF |
| Mantener selector, importar policy directamente y cargar la fábrica sólo para ejecución local | Reutiliza autorización y ejecutores, conserva OFF sin sandbox | Elegida |

`catalog/patterns.json` basta como índice descriptivo. La disponibilidad y los
permisos proceden del host, no del catálogo. `@cfworker/json-schema` reemplaza
el guard de forma propio; el límite de bytes sigue siendo una condición de transporte.
No se incorpora otra dependencia ni otro flujo de instalación.

## Unidades verificables

1. Reproducir v3 en copia desechable, con salidas y hashes reales.
2. Conservar el resolver y su contrato; integrar cfworker y comprobar paridad.
3. Conectar llamada directa a la policy actual y programa al worker real.
4. Exponer API pequeña y CLI con catálogo sintético controlado por el host.
5. Ejecutar P01–P15, revisión independiente, gates del repositorio y publicación
   del candidato sobre la rama existente. Detenerse para revisión del mantenedor.

### Coordinación

- **Prerrequisitos:** preflight, reglas y baseline antes de implementar.
- **Trabajo independiente:** inspección read-only del baseline y descubrimiento de métodos;
  después un propietario de código y pruebas, coordinador de evidencia y documentación.
- **Estado compartido:** un único escritor de código en el checkout de implementación;
  no modificar el núcleo ni el trabajo de otros agentes.
- **Descomposición mínima:** selector, adaptadores y pruebas son una sola unidad acoplada;
  la revisión final usa un agente distinto con contexto de conversación nuevo.

Superpowers aporta RED → GREEN y verificación antes de declarar resultados.
pstack aporta propiedad de escritura y los principios `model-the-domain`,
`boundary-discipline` y `prove-it-works`: un sobre de datos validado, autoridad
host separada y pruebas sobre ejecución observable. Hardening Loop limita las
correcciones al PoC. EGM Lite aporta la revisión adversarial del diff final.
No se declara FULL_EVAL, diversidad de modelos ni aislamiento del sistema de archivos.

## Baseline reproducido y límites

El `verify.sh` original terminó con código 1 porque interpreta TAP y Node 24
emitió otro formato. La reproducción con `--test-reporter=tap`, sin cambiar las
expectativas ni la implementación, obtuvo 55/55 positivos y 220/220 comparaciones.
Las cinco regresiones de policy fallaron con código 1. En una copia temporal,
el parche experimental conservó 55/55 y obtuvo 5/5 en esas regresiones.

La policy actual coincide byte a byte con el fixture original. El PoC usará
validadores host que cumplen su contrato (`true` o mensaje de error no vacío),
y conservará las regresiones explícitas. Este carril no corrige la policy.

Al importar la fábrica local actual se cargan las definiciones de worker,
inline y pool. La prueba debe distinguir importación, inicialización WASM y
creación de threads; no prometer separación de imports por backend.
Native exige un adapter real suministrado por un host compatible. Una simulación
sólo verifica su contrato y deja la integración del host en `NOT_VERIFIED`.

## Cierre

El [handoff](HANDOFF-POC.md) y la [evidencia del PoC](evidence/POC.md) registran
el resultado final. Las pruebas históricas permanecen identificadas como tales.
La siguiente fase requiere la revisión del mantenedor.
