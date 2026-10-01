#!/usr/bin/env python3
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
site = root / "site"
output = site / "index.html"

def find_one(name: str) -> Path:
    matches = list(site.rglob(name))
    if not matches:
        raise SystemExit(f"Missing generated asset: {name}")
    if len(matches) > 1:
        # Prefer the one inside the generated bundle, not an unrelated copy.
        matches.sort(key=lambda p: (0 if "vs/code/browser/workbench" in p.as_posix() else 1, len(p.parts)))
    return matches[0]

workbench_js = find_one("workbench.js")
workbench_css = find_one("workbench.css")
nls = find_one("nls.messages.js")
manifest = find_one("manifest.json")

def url(path: Path) -> str:
    return "./" + path.relative_to(site).as_posix()

configuration = {
    "productConfiguration": {"enableTelemetry": False},
    "workspaceUri": {"scheme": "tmp", "path": "/default.code-workspace"},
}

settings = html.escape(json.dumps(configuration, separators=(",", ":")), quote=True)

html_text = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta id="vscode-workbench-web-configuration" data-settings="{settings}">
<meta id="vscode-workbench-web-base-url" data-settings=".">
<meta id="vscode-workbench-auth-session" data-settings="">
<link rel="icon" href="./resources/server/favicon.ico" type="image/x-icon">
<link rel="manifest" href="{url(manifest)}" crossorigin="use-credentials">
<link rel="stylesheet" href="{url(workbench_css)}">
</head>
<body aria-label=""></body>
<script>
globalThis._VSCODE_FILE_ROOT = new URL('./', document.baseURI).toString();
globalThis._VSCODE_WEB_BASE_URL = new URL('./', document.baseURI).toString();
globalThis._VSCODE_NLS_URL = new URL('{url(nls)}', document.baseURI).toString();
performance.mark('code/willLoadWorkbenchMain');
</script>
<script src="{url(nls)}"></script>
<script src="{url(workbench_js)}"></script>
</html>
"""

output.write_text(html_text, encoding="utf-8")

print(f"workbench.js:  {workbench_js.relative_to(site)}")
print(f"workbench.css:  {workbench_css.relative_to(site)}")
print(f"nls.messages.js: {nls.relative_to(site)}")
