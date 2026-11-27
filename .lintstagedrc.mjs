export default {
  "*.{js,mjs,cjs,ts,tsx,json,jsonc}": "biome check --no-errors-on-unmatched",
  // La forma función evita que lint-staged agregue rutas: tsc con archivos ignora tsconfig.json.
  "*.{ts,tsx}": () => "npm run typecheck",
  "*.md": "markdownlint-cli2 --no-globs",
  "*": "npm run lint:spell",
};
