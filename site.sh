cd vscode
npm run gulp vscode-web-min

node build/next/index.ts bundle \
            --out out-vscode-web-shell \
            --target server-web \
            --minify \
            --nls


cat > /tmp/prepare-site.sh <<'EOF'
set -euo pipefail

cd ~/IdeaProjects/PythOnline

rm -rf site
mkdir -p site
cp -a vscode-web/. site/

test -f site/out/vs/code/browser/workbench/workbench.html

python3 - <<'PY'
from pathlib import Path
import html

template = Path("site/out/vs/code/browser/workbench/workbench.html")
index = template.read_text()

replacements = {
    "{{WORKBENCH_WEB_BASE_URL}}": ".",
    "{{WORKBENCH_NLS_FALLBACK_URL}}": "./out/nls.messages.js",
    "{{WORKBENCH_NLS_URL}}": "./out/nls.messages.js",
    "{{WORKBENCH_AUTH_SESSION}}": "",
    "{{WORKBENCH_SCRIPT_NONCE}}": "",
    "{{WORKBENCH_WEB_CONFIGURATION}}": html.escape(
        '{"productConfiguration":{"enableTelemetry":false},"workspaceUri":{"scheme":"tmp","path":"/default.code-workspace"}}',
        quote=True,
    ),
}

for key, value in replacements.items():
    index = index.replace(key, value)

if "{{" in index:
    raise SystemExit("Unresolved VS Code workbench template placeholders remain")

Path("site/index.html").write_text(index)
PY

mkdir -p site/resources/server

copy_asset() {
  local target="$1"
  shift
  local found
  found="$(find site \( -type f -o -type l \) "$@" -print -quit)"

  if [ -z "$found" ]; then
    echo "Missing required VS Code web asset: $target"
    exit 1
  fi

  cp -f "$found" "site/$target"
  echo "Normalized $target from $found"
}

shell_js="vscode/out-vscode-web-shell/vs/code/browser/workbench/workbench.js"
shell_css="vscode/out-vscode-web-shell/vs/code/browser/workbench/workbench.css"

test -s "$shell_js"
test -s "$shell_css"

mkdir -p site/out/vs/code/browser/workbench

cp -f "$shell_js" \
  site/out/vs/code/browser/workbench/workbench.js

cp -f "$shell_css" \
  site/out/vs/code/browser/workbench/workbench.css

copy_asset "resources/server/manifest.json" \
  -name "manifest.json"

copy_asset "resources/server/favicon.ico" \
  -name "favicon.ico"

copy_asset "resources/server/code-192.png" \
  -name "code-192.png"

copy_asset "resources/server/code-512.png" \
  -name "code-512.png"

test -s site/out/vs/code/browser/workbench/workbench.css
test -s site/out/vs/code/browser/workbench/workbench.js
test -s site/resources/server/manifest.json

touch site/.nojekyll

echo "=== site ready ==="
EOF

bash /tmp/prepare-site.sh
