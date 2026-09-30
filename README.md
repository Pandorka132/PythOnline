# PythOnline

PythOnline is a browser-based Python IDE built on the real VS Code Web / Code - OSS codebase.

## Current stage

The repository contains the GitHub Pages build pipeline for the VS Code Web base.

- VS Code is built from Microsoft's microsoft/vscode repository in GitHub Actions.
- Generated build files are not committed here.
- GitHub Pages is deployed with GitHub Actions.
- Python/Pyodide is intentionally not included yet.

## GitHub Pages

In Settings -> Pages, select GitHub Actions as the source.

A push to main builds VS Code Web and deploys it automatically.
