#!/usr/bin/env python3
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
site = root / "site"
template = site / "out/vs/code/browser/workbench/workbench.html"
output = site / "index.html"

if not template.is_file():
    raise SystemExit(f"Missing server-web workbench template: {template}")

configuration = {
    "productConfiguration": {"enableTelemetry": False},
    "workspaceUri": {"scheme": "tmp", "path": "/default.code-workspace"},
}

text = template.read_text(encoding="utf-8")

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
    raise SystemExit("Unresolved VS Code template placeholders remain in index.html")

output.write_text(text, encoding="utf-8")
print("Generated site/index.html from the server-web template")
