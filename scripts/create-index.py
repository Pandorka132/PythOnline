#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
site = root / "site"
output = site / "index.html"

# Use the actual server-web workbench bundle directly. Do not load
# VS Code's build-time workbench.html template.
workbench_js = "vs/code/browser/workbench/workbench.js"
workbench_css = "vs/code/browser/workbench/workbench.css"
nls = "out/nls.messages.js"

html = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PythOnline</title>
  <link rel="stylesheet" href="./{workbench_css}">
</head>
<body>
  <div id="workbench-web-container"></div>
  <script>
    globalThis._VSCODE_FILE_ROOT = new URL("./", document.baseURI).toString();
    globalThis._VSCODE_WEB_BASE_URL = new URL("./", document.baseURI).toString();
    globalThis._VSCODE_NLS_URL = new URL("./{nls}", document.baseURI).toString();
  </script>
  <script src="./{nls}"></script>
  <script src="./{workbench_js}"></script>
</body>
</html>
"""

output.write_text(html, encoding="utf-8")
