const vscode = require("vscode");

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = "https://cdn.jsdelivr.net/npm/pyodide@" + PYODIDE_VERSION + "/";
const DB_NAME = "pythonline-pyodide";
const DB_VERSION = 1;
const STORE = "state";

let runtimePromise;
let installed = new Set();

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open Pyodide database"));
  });
}

async function loadSavedPackages() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get("packages");
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error("Could not load saved packages"));
  });
}

async function savePackages(packages) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(packages, "packages");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Could not save packages"));
  });
}

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const mod = await import(INDEX_URL + "pyodide.mjs");
      const pyodide = await mod.loadPyodide({ indexURL: INDEX_URL });

      const saved = await loadSavedPackages();
      if (saved.length) {
        await pyodide.loadPackage("micropip");
        for (const spec of saved) {
          try {
            await pyodide.runPythonAsync(
              "import micropip\\nawait micropip.install(" + JSON.stringify(spec) + ")"
            );
            installed.add(spec);
          } catch (error) {
            console.warn("Failed to restore package", spec, error);
          }
        }
      }

      return pyodide;
    })();
  }

  return runtimePromise;
}

async function runPython(code) {
  const pyodide = await getRuntime();
  let output = "";
  let error = "";

  pyodide.setStdout({ batched: text => { output += text; } });
  pyodide.setStderr({ batched: text => { error += text; } });

  try {
    const result = await pyodide.runPythonAsync(code);
    if (result !== undefined && result !== null) output += String(result);
  } catch (exception) {
    error += exception && exception.message ? exception.message : String(exception);
  }

  return { output, error };
}

async function installPackage(spec) {
  const pyodide = await getRuntime();
  await pyodide.loadPackage("micropip");
  await pyodide.runPythonAsync(
    "import micropip\\nawait micropip.install(" + JSON.stringify(spec) + ")"
  );
  installed.add(spec);
  await savePackages([...installed].sort());
}

async function listPackages() {
  const pyodide = await getRuntime();
  return JSON.parse(
    pyodide.runPython(
      "import json, importlib.metadata; json.dumps([(d.metadata['Name'], d.version) for d in importlib.metadata.distributions()])"
    )
  );
}

async function readWorkspaceFile(path) {
  const uri = vscode.Uri.parse("pythonline:" + path);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder().decode(bytes);
}

async function executeResult(code) {
  return runPython(code);
}

async function execute(context, code) {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Pyodide indítása…" },
    () => runPython(code)
  );

  const channel = vscode.window.createOutputChannel("PythOnline Python");
  channel.clear();
  if (result.output) channel.append(result.output);
  if (result.error) channel.appendLine(result.error);
  channel.show(true);

  if (result.error) throw new Error(result.error);
}

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("pythonline.runPythonFile", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error("Nincs megnyitott Python fájl.");
        await execute(context, editor.document.getText());
      } catch (error) {
        vscode.window.showErrorMessage("Python futtatási hiba: " + error.message);
      }
    }),

    vscode.commands.registerCommand("pythonline.runPythonPath", async (path) => {
      const code = await readWorkspaceFile(path);
      return executeResult(code);
    }),

    vscode.commands.registerCommand("pythonline.runPythonSelection", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) throw new Error("Jelölj ki egy Python kódrészletet.");
        await execute(context, editor.document.getText(editor.selection));
      } catch (error) {
        vscode.window.showErrorMessage("Python futtatási hiba: " + error.message);
      }
    }),

    vscode.commands.registerCommand("pythonline.installPythonPackage", async () => {
      try {
        const spec = await vscode.window.showInputBox({
          prompt: "Pyodide csomag telepítése",
          placeHolder: "numpy vagy requests==2.32.5"
        });
        if (!spec) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Telepítés: " + spec },
          () => installPackage(spec)
        );
        vscode.window.showInformationMessage("Telepítve: " + spec);
      } catch (error) {
        vscode.window.showErrorMessage("Csomagtelepítési hiba: " + error.message);
      }
    }),

    vscode.commands.registerCommand("pythonline.showPythonRuntime", async () => {
      try {
        const pyodide = await getRuntime();
        const version = pyodide.runPython("import sys; sys.version");
        const packages = await listPackages();
        vscode.window.showInformationMessage(
          "Pyodide " + version + " — " + packages.length + " telepített csomag"
        );
      } catch (error) {
        vscode.window.showErrorMessage("Pyodide hiba: " + error.message);
      }
    })
  );
}

module.exports = { activate };
