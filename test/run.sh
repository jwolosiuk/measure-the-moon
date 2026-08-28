#!/bin/sh
# The host has no node, so everything runs in a container (chamber convention).
#   geometry.test.mjs — the maths, graded against numerical integration
#   analyze.test.mjs  — the analyser, graded against Moons of known phase
#   smoke.mjs         — the real page driven through jsdom
# --unit skips the jsdom pass (which has to npm install).
set -e
cd "$(dirname "$0")/.."

echo "== geometry and analysis (node --test) =="
docker run --rm -v "$PWD:/app:ro" -w /app node:22-alpine node --test test/*.test.mjs

[ "$1" = "--unit" ] && exit 0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r index.html js test "$work/"
echo '{"type":"module"}' > "$work/package.json"

echo "== the page, in jsdom =="
# --user so node_modules stays deletable from the host; HOME for the npm cache.
docker run --rm -v "$work:/w" -w /w -e HOME=/w --user "$(id -u):$(id -g)" \
	node:22-alpine sh -c 'npm install --silent --no-fund --no-audit jsdom >/dev/null 2>&1 && node test/smoke.mjs'
