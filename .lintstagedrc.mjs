export default {
  "*.{js,mjs,cjs,ts,tsx,json,jsonc}": "biome check --no-errors-on-unmatched",
  // Forma función: lint-staged no agrega rutas, así tsc respeta tsconfig.json.
  // La guarda del índice evita imports resueltos sólo en el disco.
  "*.{ts,tsx}": () => "npm run typecheck:staged",
  "tsconfig*.json": () => "npm run typecheck",
  "*.md": "markdownlint-cli2 --no-globs",
  "*": "npm run lint:spell",
};
