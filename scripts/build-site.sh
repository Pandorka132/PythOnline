#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="$ROOT/vscode"
OUT="$VSCODE/out-pythonline"
OUT_REL="out-pythonline"
SITE="$ROOT/site"

if [ ! -d "$VSCODE" ]; then
  echo "Missing VS Code checkout: $VSCODE"
  exit 1
fi

if [ ! -f "$ROOT/extensions/browser-fs/package.json" ] || [ ! -f "$ROOT/extensions/browser-fs/extension.js" ]; then
  echo "Missing browser-fs extension"
  exit 1
fi

if [ ! -f "$ROOT/extensions/pyodide-runtime/package.json" ] || [ ! -f "$ROOT/extensions/pyodide-runtime/extension.js" ] || [ ! -f "$ROOT/extensions/pyodide-runtime/worker.js" ]; then
  echo "Missing Pyodide runtime extension"
  exit 1
fi

cd "$VSCODE"

echo "==> Building VS Code web extensions"
npm run gulp compile-web

echo "==> Packaging VS Code web extensions"
node "$ROOT/scripts/package-vscode-web-extensions.ts"

echo "==> Building VS Code server-web bundle"
rm -rf "$OUT"

node build/next/index.ts bundle \
  --target server-web \
  --minify \
  --mangle-privates \
  --nls \
  --out "$OUT_REL"

echo "==> Preparing static site"
rm -rf "$SITE"
mkdir -p "$SITE"

cp -a "$OUT"/. "$SITE"/

cp "$ROOT/coi-serviceworker.js" "$SITE/coi-serviceworker.js"

mkdir -p "$SITE/resources/server"
cp -a "$VSCODE/resources/server/." "$SITE/resources/server/"

# server-web expects the compiled built-in extensions at /extensions.
if [ ! -d "$VSCODE/.build/extensions" ]; then
  echo "Missing compiled VS Code extensions: $VSCODE/.build/extensions"
  exit 1
fi
mkdir -p "$SITE/extensions"
cp -a "$VSCODE/.build/extensions/." "$SITE/extensions/"

mkdir -p "$SITE/extensions/pythonline-browser-fs"
cp -a "$ROOT/extensions/browser-fs/." "$SITE/extensions/pythonline-browser-fs/"

mkdir -p "$SITE/extensions/pythonline-pyodide-runtime"
cp -a "$ROOT/extensions/pyodide-runtime/." "$SITE/extensions/pythonline-pyodide-runtime/"

python3 "$ROOT/scripts/create-index.py"

echo "==> Validating output"

required=(
  "$SITE/index.html"
  "$SITE/coi-serviceworker.js"
  "$SITE/resources/server/manifest.json"
  "$SITE/resources/server/favicon.ico"
  "$SITE/extensions/pythonline-browser-fs/package.json"
  "$SITE/extensions/pythonline-browser-fs/extension.js"
  "$SITE/extensions/pythonline-browser-fs/package.nls.json"
  "$SITE/extensions/pythonline-pyodide-runtime/package.json"
  "$SITE/extensions/pythonline-pyodide-runtime/extension.js"
  "$SITE/extensions/theme-defaults/package.json"
  "$SITE/extensions/theme-seti/package.json"
)

for file in "${required[@]}"; do
  if [ ! -s "$file" ]; then
    echo "Missing required site asset: $file"
    exit 1
  fi
done

if grep -q '{{[A-Z_]*}}' "$SITE/index.html"; then
  echo "Unresolved VS Code template placeholders remain in site/index.html"
  exit 1
fi

touch "$SITE/.nojekyll"

echo "=== site ready ==="
echo "Serve locally with:"
echo "  python3 -m http.server 8080 -d site"
