#!/usr/bin/env python3
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
workbench = root / "site/vs/code/browser/workbench/workbench.html"
index = root / "site/index.html"

configuration = {
    "productConfiguration": {"enableTelemetry": False},
    "workspaceUri": {"scheme": "tmp", "path": "/default.code-workspace"},
}

def render(template: Path, output: Path, base_url: str) -> None:
    text = template.read_text(encoding="utf-8")
    replacements = {
        "{{WORKBENCH_WEB_BASE_URL}}": base_url,
        "{{WORKBENCH_NLS_FALLBACK_URL}}": f"{base_url}/out/nls.messages.js",
        "{{WORKBENCH_NLS_URL}}": f"{base_url}/out/nls.messages.js",
        "{{WORKBENCH_AUTH_SESSION}}": "",
        "{{WORKBENCH_SCRIPT_NONCE}}": "",
        "{{WORKBENCH_WEB_CONFIGURATION}}": html.escape(
            json.dumps(configuration, separators=(",", ":")), quote=True
        ),
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    if "{{" in text or "}}" in text:
        raise SystemExit(f"Unresolved VS Code template placeholders remain in {output}")
    output.write_text(text, encoding="utf-8")

render(workbench, index, ".")
render(workbench, workbench, "../../../../")
