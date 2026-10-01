#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE="$ROOT/vscode"
OUT="$ROOT/out-pythonline"
OUT_REL="../out-pythonline"
SITE="$ROOT/site"

if [ ! -d "$VSCODE" ]; then
  echo "Missing VS Code checkout: $VSCODE"
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

python3 "$ROOT/scripts/create-index.py"

# The server-web bundle may reference its nested workbench.html directly.
# Patch every generated HTML file so no VS Code build-time placeholders survive.
python3 - "$SITE" <<'PY'
from pathlib import Path
import html
import json
import sys

site = Path(sys.argv[1])
config = html.escape(json.dumps({
    "productConfiguration": {"enableTelemetry": False},
    "workspaceUri": {"scheme": "tmp", "path": "/default.code-workspace"},
}, separators=(",", ":")), quote=True)

placeholders = (
    "{{WORKBENCH_WEB_BASE_URL}}",
    "{{WORKBENCH_NLS_URL}}",
    "{{WORKBENCH_NLS_FALLBACK_URL}}",
    "{{WORKBENCH_WEB_CONFIGURATION}}",
)

for path in site.rglob("*.html"):
    text = path.read_text(encoding="utf-8")
    if not any(p in text for p in placeholders):
        continue

    rel = path.parent.relative_to(site)
    base = "." if not rel.parts else "/".join(".." for _ in rel.parts)

    replacements = {
        "{{WORKBENCH_WEB_BASE_URL}}": base,
        "{{WORKBENCH_NLS_FALLBACK_URL}}": f"{base}/out/nls.messages.js",
        "{{WORKBENCH_NLS_URL}}": f"{base}/out/nls.messages.js",
        "{{WORKBENCH_AUTH_SESSION}}": "",
        "{{WORKBENCH_SCRIPT_NONCE}}": "",
        "{{WORKBENCH_WEB_CONFIGURATION}}": config,
    }

    for key, value in replacements.items():
        text = text.replace(key, value)

    path.write_text(text, encoding="utf-8")
PY

echo "==> Validating output"

required=(
  "$SITE/index.html"
  "$SITE/out/nls.messages.js"
  "$SITE/vs/code/browser/workbench/workbench.html"
  "$SITE/vs/code/browser/workbench/workbench.js"
  "$SITE/vs/code/browser/workbench/workbench.css"
  "$SITE/resources/server/manifest.json"
  "$SITE/resources/server/favicon.ico"
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
