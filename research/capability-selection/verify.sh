#!/bin/sh
# Reproducible baseline + isolated patch experiment. Never edits a repo checkout.
set -eu
cd "$(dirname "$0")"
[ "$(git hash-object fixtures/baseline/policy.ts)" = '016d9f46c72d30284148f602261b275d8d18e933' ]
[ "$(git hash-object fixtures/baseline/vendor/cf-utils.ts)" = 'bbd22be192df64e6a69ce617007d5836f29b4481' ]
mkdir -p evidence
node -v > evidence/environment.txt
npm -v >> evidence/environment.txt
python -c 'import importlib.metadata; print("Python jsonschema", importlib.metadata.version("jsonschema"))' >> evidence/environment.txt
python schema-parity.py > evidence/schema-parity.txt 2>&1
npm test > evidence/node-tests.txt 2>&1
set +e
npm run test:policy-gate > evidence/baseline-policy-gate.txt 2>&1
red=$?
set -e
# An unexpected PASS or harness failure is NOT equivalent to the observed red regression.
[ "$red" = 1 ]
grep -q '# fail 5' evidence/baseline-policy-gate.txt
[ "$(grep -c 'not ok .*policy fail-closed:' evidence/baseline-policy-gate.txt)" = 5 ]
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
cp -R fixtures tests selection.mjs package.json policy-validation-experiment.patch "$tmp/"
(cd "$tmp" && git apply policy-validation-experiment.patch && npm test) > evidence/patched-node-tests.txt 2>&1
(cd "$tmp" && npm run test:policy-gate) > evidence/patched-policy-gate.txt 2>&1
[ "$(git hash-object fixtures/baseline/policy.ts)" = '016d9f46c72d30284148f602261b275d8d18e933' ]
printf '%s\n' 'schema parity exit=0' 'baseline positive suite exit=0' "baseline fail-closed gate exit=$red (5 named failures; expected red)" 'patched fixture positive suite exit=0' 'patched fixture fail-closed gate exit=0' 'original policy Git blob remains unchanged' > evidence/exits.txt
cat evidence/exits.txt
