#!/usr/bin/env python3
from pathlib import Path
import html
import json

root = Path(__file__).resolve().parents[1]
site = root / "site"
output = site / "index.html"

configuration = {
    "productConfiguration": {
        "enableTelemetry": False
    },
    "workspaceUri": {
        "scheme": "tmp",
        "path": "/default.code-workspace"
    }
}

settings = html.escape(json.dumps(configuration, separators=(",", ":")), quote=True)

html_text = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="PythOnline" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

<meta id="vscode-workbench-web-configuration" data-settings="{settings}">
<meta id="vscode-workbench-web-base-url" data-settings=".">
<meta id="vscode-workbench-auth-session" data-settings="">

<link rel="icon" href="./resources/server/favicon.ico" type="image/x-icon" />
<link rel="manifest" href="./resources/server/manifest.json" crossorigin="use-credentials" />
<link rel="stylesheet" href="./out/vs/code/browser/workbench/workbench.css">
</head>

<body aria-label=""></body>

<script>
const baseUrl = new URL('.', window.location.origin + window.location.pathname).toString().replace(/\\/$/, '');
globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/';
performance.mark('code/willLoadWorkbenchMain');
</script>

<script type="module" src="./out/nls.messages.js"></script>
<script type="module" src="./out/vs/code/browser/workbench/workbench.js"></script>
</html>
"""

output.write_text(html_text, encoding="utf-8")
