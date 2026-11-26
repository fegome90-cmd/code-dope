# Seguridad

Si encuentras un problema, repórtalo al mantenedor por un canal privado acordado. No abras un issue público ni incluyas credenciales, datos reales o material de explotación. Describe la versión afectada, el impacto y el mínimo necesario para verificarlo defensivamente.

El código del modelo sólo se ejecuta dentro de QuickJS-WASM; nunca en el host mediante `node:vm`, `eval` o `new Function`. La policy es fail-closed y los consumidores habilitan explícitamente las herramientas host. Las credenciales permanecen fuera del repo y del guest. Los workers comparten proceso y no son un límite de sistema operativo. El pool sigue opt-in: el crash nativo registrado en `bench/SOAK.json` no tiene causa identificada y una corrida posterior exitosa no prueba su corrección. Los checks y el flujo de revisión están en [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

El dueño autorizó el 2026-11-26 la licencia MIT para el código propio, con copyright «2026 Felipe González». [LICENSE](LICENSE) contiene el texto completo y coincide con `license: "MIT"` de `package.json`. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) conserva las atribuciones y licencias del código de terceros. El paquete mantiene `private: true`; esta decisión no autoriza publicación, despliegue ni merge.
