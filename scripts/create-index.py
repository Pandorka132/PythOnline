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
    if not extension_dir.is_dir() or extension_dir.name == "pythonline-browser-fs":
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
    "productConfiguration": {"enableTelemetry": False},
    "folderUri": {"scheme": "pythonline", "path": "/workspace"},
    "additionalBuiltinExtensions": [{
        "scheme": "__PYTHONLINE_PROTOCOL__",
        "authority": "__PYTHONLINE_AUTHORITY__",
        "path": "/extensions/pythonline-browser-fs",
    }],
}

builtin_extensions_json = json.dumps(builtin_extensions, separators=(",", ":"))

text = template.read_text(encoding="utf-8")

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

builtin_meta = f'<meta id="vscode-workbench-builtin-extensions" data-settings="{html.escape(builtin_extensions_json, quote=True)}">'
text = text.replace("<!-- Workbench Auth Session -->", builtin_meta + "\n\n<!-- Workbench Auth Session -->", 1)

bootstrap = """
<script nonce="">
const workbenchConfiguration = document.getElementById('vscode-workbench-web-configuration');
const configuration = JSON.parse(workbenchConfiguration.getAttribute('data-settings'));
for (const extension of configuration.additionalBuiltinExtensions ?? []) {
    if (extension.scheme === '__PYTHONLINE_PROTOCOL__') {
        extension.scheme = window.location.protocol.slice(0, -1);
    }
    if (extension.authority === '__PYTHONLINE_AUTHORITY__') {
        extension.authority = window.location.host;
    }
}
workbenchConfiguration.setAttribute('data-settings', JSON.stringify(configuration));
</script>
"""

marker = "<!-- Workbench Auth Session -->"
if marker not in text:
    raise SystemExit("Could not find Workbench Auth Session marker in server-web template")
text = text.replace(marker, bootstrap + "\n" + marker, 1)

unresolved = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if unresolved:
    raise SystemExit(
        "Unresolved VS Code template placeholders: "
        + ", ".join(sorted(set(unresolved)))
    )

output.write_text(text, encoding="utf-8")
print("Generated site/index.html with PythOnline browser filesystem")
