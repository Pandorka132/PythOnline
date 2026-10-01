#!/usr/bin/env python3
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
template = root / "site/vs/code/browser/workbench/workbench.html"
output = root / "site/index.html"

text = template.read_text(encoding="utf-8")

configuration = {
    "productConfiguration": {
        "enableTelemetry": False
    },
    "workspaceUri": {
        "scheme": "tmp",
        "path": "/default.code-workspace"
    }
}

replacements = {
    "{{WORKBENCH_WEB_BASE_URL}}": ".",
    "{{WORKBENCH_NLS_FALLBACK_URL}}": "./out/nls.messages.js",
    "{{WORKBENCH_NLS_URL}}": "./out/nls.messages.js",
    "{{WORKBENCH_AUTH_SESSION}}": "",
    "{{WORKBENCH_SCRIPT_NONCE}}": "",
    "{{WORKBENCH_WEB_CONFIGURATION}}": html.escape(
        json.dumps(configuration, separators=(",", ":")),
        quote=True,
    ),
}

for key, value in replacements.items():
    text = text.replace(key, value)

if "{{" in text or "}}" in text:
    raise SystemExit("Unresolved VS Code template placeholders remain")

output.write_text(text, encoding="utf-8")
