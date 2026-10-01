#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="$ROOT/vscode"
OUT="$ROOT/out-pythonline"
OUT_REL="../out-pythonline"
SITE="$ROOT/site"

if [ ! -d "$VSCODE" ]; then
  echo "Missing VS Code checkout: $VSCODE"
  exit 1
fi

if [ ! -f "$ROOT/browser-fs/package.json" ] || [ ! -f "$ROOT/browser-fs/extension.js" ]; then
  echo "Missing browser-fs extension"
  exit 1
fi

cd "$VSCODE"

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

mkdir -p "$SITE/resources/server"
cp -a "$VSCODE/resources/server/." "$SITE/resources/server/"

mkdir -p "$SITE/extensions/pythonline-browser-fs"
cp -a "$ROOT/browser-fs/." "$SITE/extensions/pythonline-browser-fs/"

python3 "$ROOT/scripts/create-index.py"

echo "==> Validating output"

required=(
  "$SITE/index.html"
  "$SITE/resources/server/manifest.json"
  "$SITE/resources/server/favicon.ico"
  "$SITE/extensions/pythonline-browser-fs/package.json"
  "$SITE/extensions/pythonline-browser-fs/extension.js"
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
