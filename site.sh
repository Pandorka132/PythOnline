cd vscode
npm run gulp vscode-web-min


cat > /tmp/prepare-site.sh <<'EOF'
set -euo pipefail

cd ~/IdeaProjects/PythOnline

rm -rf site
mkdir -p site
cp -a vscode/out-vscode-web-min/. site/

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

test -s site/out/vs/code/browser/workbench/workbench.js
test -s site/out/vs/code/browser/workbench/workbench.css
test -s site/out/nls.messages.js

touch site/.nojekyll

echo "=== site ready ==="
EOF

bash /tmp/prepare-site.sh
