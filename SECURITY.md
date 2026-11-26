# Seguridad

Si encuentras un problema, repórtalo al mantenedor por un canal privado acordado. No abras un issue público ni incluyas credenciales, datos reales o material de explotación. Describe la versión afectada, el impacto y el mínimo necesario para verificarlo defensivamente.

El código del modelo sólo se ejecuta dentro de QuickJS-WASM; nunca en el host mediante `node:vm`, `eval` o `new Function`. La policy es fail-closed y los consumidores habilitan explícitamente las herramientas host. Las credenciales permanecen fuera del repo y del guest. Los workers comparten proceso y no son un límite de sistema operativo. El pool sigue opt-in: el crash nativo registrado en `bench/SOAK.json` no tiene causa identificada y una corrida posterior exitosa no prueba su corrección. Los checks y el flujo de revisión están en [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia pendiente de decisión

`package.json` declara MIT, pero no hay archivo de licencia propio. `THIRD_PARTY_NOTICES.md` conserva las licencias de terceros y no resuelve esa discrepancia. El dueño debe decidir antes de añadir, retirar o cambiar la licencia del proyecto; esta integración mantiene el estado existente.
