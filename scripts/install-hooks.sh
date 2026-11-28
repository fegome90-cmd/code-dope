#!/usr/bin/env bash
set -euo pipefail

# Husky escribe core.hooksPath en la config local compartida por todos los worktrees.
# Se preserva el valor previo y se aplica el override sólo a este worktree.
previous=$(git config --local --get core.hooksPath || true)
git config extensions.worktreeConfig true
npm exec husky
if [ -n "${previous}" ]; then
  git config --local core.hooksPath "${previous}"
else
  git config --local --unset core.hooksPath 2>/dev/null || true
fi
git config --worktree core.hooksPath .husky/_
