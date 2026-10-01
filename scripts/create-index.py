#!/usr/bin/env python3
from pathlib import Path
import html
import json
import re

root = Path(__file__).resolve().parents[1]
site = root / "site"
template = site / "vs/code/browser/workbench/workbench.html"
output = site / "index.html"

if not template.is_file():
    raise SystemExit(f"Missing server-web workbench template: {template}")

builtin_extensions = []
for extension_dir in sorted((site / "extensions").iterdir()):
    if not extension_dir.is_dir():
        continue

    package_json = extension_dir / "package.json"
    if not package_json.is_file():
        continue

    manifest = json.loads(package_json.read_text(encoding="utf-8"))
    builtin_extensions.append({
        "extensionPath": extension_dir.name,
        "packageJSON": manifest,
    })

configuration = {
    "productConfiguration": {
        "enableTelemetry": False,
        "extensionsGallery": {
            "serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
            "itemUrl": "https://marketplace.visualstudio.com/items",
            "publisherUrl": "https://marketplace.visualstudio.com/publishers",
            "resourceUrlTemplate": "https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}",
            "extensionUrlTemplate": "https://www.vscode-unpkg.net/_gallery/{publisher}/{name}/latest"
        }
    }
}

builtin_extensions_json = json.dumps(builtin_extensions, separators=(",", ":"))

text = template.read_text(encoding="utf-8")

coi_script = '<script src="./coi-serviceworker.js"></script>'

if '<head>' in text:
    text = text.replace('<head>', '<head>\n' + coi_script, 1)
else:
    raise SystemExit("Could not find <head> in server-web template")

replacements = {
    "{{WORKBENCH_WEB_BASE_URL}}": ".",
    "{{WORKBENCH_NLS_FALLBACK_URL}}": "./nls.messages.js",
    "{{WORKBENCH_NLS_URL}}": "./nls.messages.js",
    "{{WORKBENCH_AUTH_SESSION}}": "",
    "{{WORKBENCH_BUILTIN_EXTENSIONS}}": "[]",
    "{{WORKBENCH_DEV_CSS_MODULES}}": "[]",
    "{{WORKBENCH_SCRIPT_NONCE}}": "",
    "{{WORKBENCH_WEB_CONFIGURATION}}": html.escape(
        json.dumps(configuration, separators=(",", ":")),
        quote=True,
    ),
}

for key, value in replacements.items():
    text = text.replace(key, value)

text = text.replace("/out/", "/")

builtin_meta = (
    '<meta id="vscode-workbench-builtin-extensions" '
    f'data-settings="{html.escape(builtin_extensions_json, quote=True)}">'
)
marker = "<!-- Workbench Auth Session -->"
text = text.replace(marker, builtin_meta + "\n\n" + marker, 1)

unresolved = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if unresolved:
    raise SystemExit(
        "Unresolved VS Code template placeholders: "
        + ", ".join(sorted(set(unresolved)))
    )

output.write_text(text, encoding="utf-8")
print(
    "Generated site/index.html with "
    f"{len(builtin_extensions)} built-in web extensions"
)
