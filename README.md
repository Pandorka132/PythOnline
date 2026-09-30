# PythOnline

PythOnline is a browser-based Python IDE built on the real VS Code Web / Code - OSS codebase.

## Current stage

The repository builds and deploys the VS Code Web base through GitHub Actions.

- VS Code is built from Microsoft's `microsoft/vscode` repository.
- The generated VS Code Web build is not committed here.
- GitHub Pages is deployed with `actions/deploy-pages`.
- Python/Pyodide is intentionally not included yet.

## GitHub Pages

In **Settings -> Pages**, select **GitHub Actions** as the source.

A push to `main` builds VS Code Web and deploys it automatically.
