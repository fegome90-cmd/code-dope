# Hoja de ruta

## Candidato actual del PR #2

Las Fases 1–3 de [PLAN.md](../PLAN.md) implementan una biblioteca de Code Mode con QuickJS-WASM, policy host fail-closed y adaptadores MCP. El [handoff de Fase 3](../HANDOFF-2026-11-26-PHASE-3.md) registra sus pruebas locales y límites; no concede permisos de merge. El candidato se integra sobre `developer` con npm y `package-lock.json`, conservando el control del índice de Git del #4 y los tres checks requeridos. El consumidor del tarball verifica las API JS/TS y los tres modos de ejecución. Pool sigue opt-in y su crash nativo permanece sin causa confirmada.

M8/M9, publicación, despliegue y llamadas nativas a sistemas reales siguen fuera de alcance. Licencia propia pendiente de decisión. No confundir esta implementación con la propuesta declarativa de bootstrap que se conserva a continuación como antecedente.

## Propuesta histórica del bootstrap

| Fase | Entrega | Criterio de salida |
| --- | --- | --- |
| 0. Fundación | Paquete ESM privado, tipado estricto, lockfile, prueba de empaquetado y CI | Un consumidor externo importa el tarball en JavaScript y resuelve las declaraciones en TypeScript. No hay dependencias de ejecución. |
| 1. Contrato y línea base | Estudiar catálogo, plan declarativo y recibos. Hardening Loop conserva su herramienta actual durante la prueba nativa. | Contrato provisional con casos positivos y negativos; las cuatro llamadas y los recibos de Work se verifican por separado si hay conexión. No confundir la prueba local con invocación nativa. |
| 2. Núcleo | Validación previa, límites y ejecución de operaciones aprobadas; resultados por paso, sin falso éxito parcial. | Pruebas reproducibles de entradas inválidas, límites y fallos parciales; no hay efectos al importar. |
| 3. Adaptadores | Un adaptador MCP opt-in y dos consumidores distintos antes de estabilizar la API. | Ejecutar los dos consumidores contra un tarball instalado y probar el camino real del adaptador. La publicación se decide aparte. |

Sólo comparar rendimiento si existe un flujo real que agrupar. Emparejar ejecución directa y por lote con los mismos resultados internos. Separar llamadas al host, operaciones del servidor, latencia y tokens; si Work no muestra tokens, quedan no medidos.

## Qué viene de cada fuente

- [Kit fundador TypeScript](https://github.com/fegome90-cmd/kit_fundador/blob/c212571d500d737ed4d7527e41f1ae9287a3e777/templates/fastify-core/package.json): Node 24, pnpm fijado, ESM y TypeScript estricto. No trae Fastify ni un servicio al núcleo.
- [Kit fundador Python](https://github.com/fegome90-cmd/kit-fundador-python/blob/9014c932eff05498c40757db07e1ca43b6f78357/scripts/verify_template.py#L191-L255): verificar el artefacto en un consumidor independiente. Se adapta el patrón, no el script ni los servicios del kit.
- [Constitución Agéntica](https://github.com/fegome90-cmd/constitucion-ai/blob/cdb626e0960e88e3be1ce4a1755f5441a1dbe251/constitution/AGENTIC-CONSTITUTION.md): validación proporcional, evidencia distinguible y autoridad humana. No se heredan excepciones ni se crean roles permanentes.
- [UTCP Code Mode](https://github.com/universal-tool-calling-protocol/code-mode): referencia de contratos y descubrimiento. No es una dependencia ni el ejecutor de Code Dope.
