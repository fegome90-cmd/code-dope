# Reglas de Code Dope

1. Antes de editar, lee los contratos y pruebas vigentes. Fija alcance y criterio de aceptación; no congeles una interfaz propuesta sin consumidor.
2. Mantén el núcleo independiente del proveedor y del transporte, sin efectos al importar. Catálogo cerrado provisto por el consumidor, validación previa de planes y rechazo de entradas desconocidas. No agregues eval, shell, archivos/red arbitrarios, registro dinámico ni acceso implícito a credenciales.
3. Prueba también límites, fallos parciales y evidencia ambigua. Conserva el estado y la procedencia por paso sin guardar secretos. Para cambios del paquete, prueba el tarball desde un consumidor externo e identifica SHA y run cuando CI esté disponible.
4. Trabaja en rama y limpia tu entorno temporal sin borrar cambios ajenos. Revisión independiente cuando el impacto lo amerite. Evidencia técnica no autoriza merge, publicación, permisos, secretos ni cambios destructivos. No reutilices excepciones de otros repositorios.

Adaptación local de la [Constitución Agéntica v1.1](https://github.com/fegome90-cmd/constitucion-ai/blob/cdb626e0960e88e3be1ce4a1755f5441a1dbe251/constitution/AGENTIC-CONSTITUTION.md). La fuente no se copia ni se importa como dependencia. El repositorio no declara una licencia pública.

Para commits, PR, verificaciones y merges, sigue [Cómo trabajamos](CONTRIBUTING.md). La CI es evidencia, no autorización.
