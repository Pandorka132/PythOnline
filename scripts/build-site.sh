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

if [ ! -f "$ROOT/extensions/busybox/package.json" ] || [ ! -f "$ROOT/extensions/busybox/extension.js" ] || [ ! -f "$ROOT/extensions/busybox/busybox-worker.mjs" ] || [ ! -f "$ROOT/extensions/busybox/package.nls.json" ]; then
  echo "Missing BusyBox extension"
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
cp "$ROOT/scripts/pyodide-runtime.html" "$SITE/pyodide-runtime.html"
cp "$ROOT/scripts/pyodide-runtime.js" "$SITE/pyodide-runtime.js"
cp "$ROOT/extensions/pyodide-runtime/worker.js" "$SITE/pyodide-runtime-worker.js"
cp "$ROOT/scripts/busybox-runtime.html" "$SITE/busybox-runtime.html"
cp "$ROOT/scripts/busybox-runtime.js" "$SITE/busybox-runtime.js"

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

mkdir -p "$SITE/extensions/pythonline-busybox"
cp -a "$ROOT/extensions/busybox/." "$SITE/extensions/pythonline-busybox/"

# The browser terminal UI uses xterm.js at runtime. server-web does not bundle this AMD asset.
XTERM_JS="$VSCODE/node_modules/@xterm/xterm/lib/xterm.js"
XTERM_CSS="$VSCODE/node_modules/@xterm/xterm/css/xterm.css"
if [ ! -f "$XTERM_JS" ]; then
  echo "Missing xterm.js runtime asset: $XTERM_JS"
  exit 1
fi
mkdir -p "$SITE/node_modules"
# server-web may load xterm addons directly by package path, so copy the
# complete browser-side @xterm packages used by VS Code's terminal UI.
for package in xterm addon-unicode11 addon-clipboard addon-progress addon-webgl; do
  if [ -d "$VSCODE/node_modules/@xterm/$package" ]; then
    mkdir -p "$SITE/node_modules/@xterm"
    cp -a "$VSCODE/node_modules/@xterm/$package" "$SITE/node_modules/@xterm/"
  fi
done

# VS Code's browser workbench loads these CommonJS/AMD text-rendering modules
# as runtime assets rather than bundling them into workbench.js.
for package in vscode-textmate vscode-oniguruma; do
  if [ -d "$VSCODE/node_modules/$package" ]; then
    cp -a "$VSCODE/node_modules/$package" "$SITE/node_modules/"
  else
    echo "Missing VS Code runtime package: $VSCODE/node_modules/$package"
    exit 1
  fi
done

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
  "$SITE/extensions/pythonline-busybox/package.json"
  "$SITE/extensions/pythonline-busybox/extension.js"
  "$SITE/extensions/pythonline-busybox/busybox-worker.mjs"
  "$SITE/extensions/pythonline-busybox/package.nls.json"
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
