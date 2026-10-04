#!/usr/bin/env bash
# Build the web viewer and publish it to GitHub Pages
# (https://cyberhirsch.github.io/atlas-antiqua/).
#
# The gh-pages branch holds only the latest build and is force-pushed, so
# terrain tiles never pile up in git history.
#
# Needs the generated data first: scripts/build_terrain.py, scripts/export_sites.py.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
remote="$(git -C "$root" remote get-url origin)"
out="$(mktemp -d)"

# MSYS_NO_PATHCONV: Git Bash on Windows would turn /atlas-antiqua/ into a Windows path.
# Built straight into the temporary folder, so no second copy lands next to the source.
# With path conversion off, Vite needs a native path for the output folder
# (else /tmp/... resolves to the root of the current drive).
outdir="$(cygpath -m "$out" 2>/dev/null || echo "$out")"
(cd "$root/web" && npx tsc --noEmit && MSYS_NO_PATHCONV=1 ATLAS_BASE=/atlas-antiqua/ npx vite build --outDir "$outdir" --emptyOutDir)
test -f "$out/index.html" || { echo "build output missing in $out" >&2; exit 1; }
touch "$out/.nojekyll"
cd "$out"
git init -q -b gh-pages
git -c core.autocrlf=false add -A
git -c user.name="$(git -C "$root" config user.name)" -c user.email="$(git -C "$root" config user.email)" \
  commit -q -m "Deploy web viewer"
git push -q -f "$remote" gh-pages
rm -rf "$out"
echo "Deployed; GitHub Pages updates within a minute or two."
