#!/bin/sh
# Reuses the repository's npm ci installation. Logs go to a fresh OS temp directory.
set -eu
cd "$(dirname "$0")"
exec node verify.mjs
