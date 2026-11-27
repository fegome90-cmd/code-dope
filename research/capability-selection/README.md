# Code Dope — Capability Selection v3 · research fixture

**Estado: prototipo aislado, no parche aprobado ni paquete de producción.**

Este ZIP no es un checkout de Code Dope. Incluye un candidato pequeño de selección, un adaptador directo que reutiliza la policy real y tres archivos fuente originales fijados por Git blob. No incluye QuickJS, OpenCode ni un SDK MCP instalado. No modifica repositorios, plugins ni configuraciones globales.

## Reproducir las pruebas ejecutadas

Requiere Node con type stripping (se observó v22.16.0), npm, Git y Python con `jsonschema` 4.26.0. No hay dependencias npm del fixture ni instalación necesaria para el conjunto principal. Node 22.16.0 es inferior al mínimo declarado de Code Dope, 22.18. No confundir este ensayo con su CI.

```bash
./verify.sh
```

El script comprueba los hashes de la policy y el sanitizer, ejecuta paridad de esquema y pruebas positivas, reproduce el gate rojo del baseline y aplica el parche de investigación únicamente en una copia temporal. Repite las pruebas y elimina la copia. Los archivos originales permanecen intactos. `evidence/exits.txt` resume las salidas reales.

- `npm test`: 55 pruebas positivas de selección y llamada directa, sin sandbox. Debe pasar en el entorno descrito.
- `npm run test:policy-gate`: **debe fallar en la policy original** (cinco regresiones fail-closed reproducidas). No interpretar ese FAIL como fallo del harness. El script completo comprueba el resultado rojo y las cinco pruebas verdes en la copia temporal.
- `python schema-parity.py`: 220 casos comparados con Draft7Validator de Python; no es una ejecución de cfworker.
- `tsc -p tsconfig.contract.json --typeRoots <directorio-con-@types/node>`: comprobación estricta limitada al adaptador y a las fuentes exactas recuperadas. La corrida entregada usó TS 5.8.3 y @types/node 25.1.0 disponibles localmente. No es verificación de la distribución npm ni de los tipos fijados en el repositorio.

## Archivos que interesa reutilizar

- `selection.mjs`: selector cerrado, parser de solicitud serializada, vista de capacidades y dispatch diferido con revalidación. La autoridad viene exclusivamente del host; el plan no es una credencial. La carga debe limitarse a importar/preparar una función sin efectos de herramientas. El input de operación debe llegar como datos previamente validados por el host. El adapter real vuelve a aplicar policy por llamada.
- `fixtures/baseline/direct.ts`: candidato a `src/direct.ts`, **depende de que el hardening de policy sea aprobado**. Reutiliza `withPolicy` y `createAuditLog` sin evaluar código. El presupuesto de la policy es por ejecución, no por tarea o sesión. No exportar el executor interno ni permitir proveedores/policies aportados por el agente.
- `request.schema.json`: esquema generado desde `selection.mjs`, no una segunda autoridad.
- `policy-validation-experiment.patch`: experimento mínimo de regresión ya cubierto por EGM; no aplicar al repo ni reemplazar el diseño Goldfish sin revisión.
- `fixtures/baseline/policy.ts`, `vendor/cf-utils.ts`, `fixtures/upstream/executor-types.ts`: código original, fijado y comprobado por hash. Conservar avisos MIT. No copiar estas fuentes de vuelta a la biblioteca, que ya las tiene o las importa.
- `spikes/opencode-contract.test.mjs`: probe de compatibilidad **NOT_RUN**, solo verificación sintáctica. Ejecutar en otro entorno aislado tras verificar que el tarball/versión corresponden al commit, con Node >=24 y Effect compatible. No elevar el mínimo Node de Code Dope ni instalar nada automáticamente. El caso de colisión last-wins prueba un comportamiento upstream que Code Dope debe evitar, no una garantía deseada.

## Límites

No se ejecutaron QuickJS, UTCP, OpenCode, Claude Code, MCP real ni ChatGPT Code Mode en este fixture. La resolución de DNS al registro npm falló. El cambio de policy es una comprobación experimental, no cierre de los seis bloqueantes del PR #10. La elección `telemetry=extended` se demostró con un sink local sintético del consumidor, mientras la auditoría original sigue presente; no se implementó OpenTelemetry. No se midió latencia, tokens, aislamiento real, memoria o seguridad del runtime. No se añadieron nuevos paquetes de producción.
