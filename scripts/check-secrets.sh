#!/usr/bin/env bash
set -euo pipefail
cd -- "$(git rev-parse --show-toplevel)"
command -v gitleaks >/dev/null || { echo 'Falta Gitleaks.' >&2; exit 1; }
export GIT_NO_REPLACE_OBJECTS=1
case ${1:-} in
  staged) paths=(git diff --cached --diff-filter=ACMRT --name-only -z); flags=(--staged) ;;
  history)
    [[ "$(git rev-parse --is-shallow-repository)" == false ]] || { echo 'Se requiere el historial completo.' >&2; exit 1; }
    paths=(git log --full-history --name-only --format= --no-renames -z HEAD)
    flags=(--log-opts='--full-history --root --diff-merges=first-parent --text --no-textconv --no-ext-diff --no-renames HEAD')
    ;;
  *) echo 'Uso: bash scripts/check-secrets.sh staged|history' >&2; exit 2 ;;
esac
"${paths[@]}" | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const files = readFileSync(0, "utf8").split("\0").map(s => s.replace(/^\n+/, ""));
  if (files.some(p => /(^|\/)(\.env(?:\..+)?|\.netrc|\.npmrc|id_(?:rsa|ed25519))(?:$|\/)|\.(?:pem|p12|key)$/i.test(p))) {
    console.error("Ruta reservada para credenciales detectada.");
    process.exit(1);
  }'
if ! gitleaks git "${flags[@]}" --config .gitleaks.toml --redact=100 --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null . >/dev/null 2>&1; then
  echo 'Gitleaks detectó un posible secreto o no pudo completar el análisis.' >&2
  exit 1
fi
echo 'Sin hallazgos en el chequeo de secretos y rutas reservadas.'
