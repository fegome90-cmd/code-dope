# Capability selection: PoC con policy y worker reales

Este PoC permite descubrir capacidades, solicitar OFF, ON o AUTO, resolver un
plan y ejecutar herramientas sintéticas mediante la policy actual de Code Dope.
La ruta local usa el worker existente y QuickJS real. Todos los cambios permanecen
en esta carpeta de investigación; el paquete y el núcleo conservan sus contratos.

El [registro de evidencia](evidence/POC.md) distingue las pruebas ejecutadas,
los fallos conocidos y las integraciones no verificadas. El PR permanece en
borrador para revisión del mantenedor. El PoC no acredita aptitud de producción
del núcleo ni corrige el hardening del PR #10.

## Ejecutar desde la raíz del repositorio

Usa Node 24, según `.node-version`, y npm 11.19.1, según `packageManager`.
La instalación utiliza únicamente el `package-lock.json` de la raíz.

```bash
npm ci
node research/capability-selection/poc/cli.mjs capabilities --json
node research/capability-selection/poc/cli.mjs resolve --config research/capability-selection/examples/off.json
node research/capability-selection/poc/cli.mjs run --config research/capability-selection/examples/off.json
node research/capability-selection/poc/cli.mjs run --config research/capability-selection/examples/on.json
node research/capability-selection/poc/cli.mjs run --config research/capability-selection/examples/auto.json
```

OFF y ON devuelven `13` con una llamada a `math.sum`. AUTO ejecuta una composición
que devuelve `12` con dos llamadas auditadas. El CLI emite JSON y termina con
código 0 para éxito o 1 para rechazo o fallo. `resolve` no ejecuta herramientas.
No se registra todavía un ejecutable público en el paquete.

El host del CLI ofrece `math.sum` y `store.save`, ambos sintéticos y en memoria.
Permite las rutas `direct` y `worker`. `inline` y `pool` están disponibles pero
denegadas; `native` no está disponible. No existe un hook de aprobación en este
host, por lo que `store.save` se rechaza antes de entrar a la función de escritura.
El archivo del agente no puede registrar herramientas ni cambiar esas decisiones.

## Formato de una solicitud

```json
{
  "mode": "off",
  "request": {
    "schemaVersion": 1,
    "route": "direct",
    "telemetry": "minimal"
  },
  "operation": {
    "kind": "call",
    "provider": "math",
    "tool": "sum",
    "args": { "values": [5, -2, 10] }
  }
}
```

Para una ruta programática, `operation` usa `kind: "program"` y `code`, como
en [on.json](examples/on.json). El código se entrega al ejecutor existente.
La ruta directa consume datos de una llamada única y no evalúa código.

| Campo o contexto | Propietario | Efecto |
| --- | --- | --- |
| `mode` del sobre | Agente consumidor | OFF pide directo; ON pide programático; AUTO deja que el agente elija la ruta |
| `request.route` | Agente consumidor | Solicita una de las cinco rutas conocidas |
| `availableRoutes` | Host | Indica capacidades realmente presentes |
| `allowedRoutes` | Usuario o administrador, mediante el host | Limita las rutas autorizadas |
| `mode` del contexto host | Sistema o administrador | Restricción obligatoria que la solicitud no puede ampliar |
| `policy`, aprobaciones y presupuesto | Host | Se aplican a cada llamada, en cualquier ruta |
| `revision` y `policyVersion` | Host | Permiten detectar una configuración obsoleta durante la carga |
| Plan devuelto | Resolver | Describe la selección efectiva; no concede permisos |

El esquema v3 de `request` se conserva cerrado. El modo solicitado pertenece al
[sobre de ejecución](poc/run.schema.json), no a ese esquema ni a la autoridad del
host. ON sobre una ruta directa y OFF sobre una ruta programática se rechazan.
AUTO no contiene otro modelo ni un clasificador: el agente elige y el resolver
valida determinísticamente. Los controles de policy y auditoría no tienen un switch OFF.

El request v3 está limitado a 1024 bytes UTF-8; el sobre completo, a 65 536 bytes.
El programa está limitado a 32 768 caracteres. La configuración no acepta imports,
preludes, ejecutables, credenciales, políticas o callbacks arbitrarios.

## Consumir la API

[createCapabilityClient](poc/client.ts) recibe proveedores, policy y contexto
controlados por el host. Expone `capabilities()`, `resolve(json)` y `run(json)`.
El [host sintético](poc/synthetic-host.ts) muestra la integración mínima, con
validadores de argumentos mediante `@cfworker/json-schema`.

```ts
import { createCapabilityClient } from './poc/client.ts';
import { createSyntheticHost } from './poc/synthetic-host.ts';

const client = createCapabilityClient(createSyntheticHost());
const advertised = client.capabilities();
const plan = client.resolve(serializedConfig);
const result = await client.run(serializedConfig);
```

`run` vuelve a consultar el contexto después de cargar el adaptador y antes de
inicializar el ejecutor. Una revocación o cambio de revisión impide el dispatch.
Después se aplica `withPolicy()` a las funciones host. Cada ejecución conserva
su auditoría local aunque la telemetría sea mínima o falle un sink externo.
No hay fallback ni reintento automático tras un fallo o un resultado desconocido.

Un host con ejecución programática nativa puede suministrar su `Executor` mediante
`native.load()`. La carga sólo prepara el adaptador; las herramientas se reciben
protegidas por policy. La prueba de ese contrato es una simulación y deja el
funcionamiento nativo del host en `NOT_VERIFIED`. No se sustituye esa ruta por QuickJS.

## Reproducir la verificación

```bash
sh research/capability-selection/verify.sh
npm run test:all
bash scripts/check-secrets.sh staged
node scripts/check-docs.mjs
```

La comparación independiente del esquema usa Python con `jsonschema` 4.26.0.
El control de secretos requiere Gitleaks 8.30.1, como el workflow del repositorio.
No ejecutes otra instalación npm dentro de esta carpeta ni crees otro lockfile.

`verify.sh` delega a `verify.mjs`, emite recibos por gate y conserva los logs en
un directorio temporal nuevo. Usa TAP explícito, comprueba las fuentes fijadas y
ejecuta las pruebas contra el validador real. Conserva el gate rojo de la policy
original y aplica el parche experimental sólo en una copia temporal. Reutiliza
las dependencias instaladas en la raíz; no instala nada. Los recibos v3 versionados
no se sobrescriben. Las pruebas existentes y las fuentes originales se conservan.

Para comprobar sólo los tipos del PoC:

```bash
node node_modules/typescript/bin/tsc -p research/capability-selection/tsconfig.poc.json
```

## Alcance comprobable y límites

- La observación de módulos, WASM y threads se realiza en procesos nuevos. Distingue
  el WASM de Amaro usado por Node para leer TypeScript del WASM de QuickJS.
- OFF no carga los módulos de ejecución de Code Dope. Al elegir una ruta local,
  la fábrica actual importa las clases worker, inline y pool. Esa carga no implica
  que todas se inicialicen. La separación de imports por backend queda para otra etapa.
- `maxCalls` es por ejecución. Varias ejecuciones directas no comparten un presupuesto
  de tarea. Este PoC no añade un segundo contador.
- Una escritura que ya empezó puede terminar después de un timeout. Su resultado
  queda como `unknown`; no se reintenta. Un error de entrega tampoco revierte la escritura.
- Cinco regresiones fail-closed persisten en la policy actual. Los validadores del
  host sintético devuelven `true` o un mensaje de error no vacío, según el contrato.
  El parche aislado demuestra esas correcciones sin integrarlas en `src/`.
- No se validan OpenCode, UTCP, un host nativo real, instalación sin QuickJS ni
  estabilidad prolongada del pool. Los workers comparten proceso con el host.

## Investigación y continuidad

La [Parte IV del informe](RESEARCH.md) documenta esta etapa. Las partes I–III y
los recibos v3 siguen siendo historia identificada. [source-manifest.json](source-manifest.json)
y los avisos MIT conservan las fuentes fijadas. `fixtures/baseline/` no se copia
al núcleo: sólo sirve para reproducir el experimento histórico.

El [handoff](HANDOFF-POC.md) indica qué queda para la siguiente etapa. El STOP GATE
es la entrega del PoC con evidencia, antes de integración definitiva o promoción.
