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

async function executeInteractive(context, code, fileName) {
  const inputQueue = [];
  let inputLine = "";
  let waitingForInput = false;
  let worker;
  let closed = false;

  const writeEmitter = new vscode.EventEmitter();
  let ptyOpen = false;
  const pendingOutput = [];

  const write = text => {
    if (ptyOpen) writeEmitter.fire(text);
    else pendingOutput.push(text);
  };

  function flushInput() {
    if (closed || !waitingForInput || !inputQueue.length) return;
    const line = inputQueue.shift();
    waitingForInput = false;
    worker?.postMessage({ type: "stdin", data: line });
  }

  const pty = {
    onDidWrite: writeEmitter.event,
    open: () => {
      ptyOpen = true;
      for (const text of pendingOutput.splice(0)) writeEmitter.fire(text);
    },
    close: () => {
      closed = true;
      worker?.terminate();
    },
    handleInput: data => {
      if (closed) return;

      for (const char of data) {
        if (char === "\r" || char === "\n") {
          writeEmitter.fire("\r\n");
          inputQueue.push(inputLine + "\n");
          inputLine = "";
          flushInput();
        } else if (char === "\x7f" || char === "\b") {
          if (inputLine.length) {
            inputLine = inputLine.slice(0, -1);
            writeEmitter.fire("\b \b");
          }
        } else if (char === "\x03") {
          writeEmitter.fire("^C\r\n");
          inputQueue.push("\x03");
          inputLine = "";
          flushInput();
        } else if (char >= " ") {
          inputLine += char;
          writeEmitter.fire(char);
        }
      }
    }
  };

  const terminal = vscode.window.createTerminal({
    name: "Run: " + (fileName || "Python"),
    pty,
    isTransient: true
  });
  terminal.show(true);
  writeEmitter.fire("\x1b[2J\x1b[H");
  writeEmitter.fire("[PythOnline] " + (fileName || "Python") + "\r\n");
  writeEmitter.fire("[Pyodide] Worker indítása…\r\n");

  const workerUrl = vscode.Uri.joinPath(context.extensionUri, "worker.js").toString(true);
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (error) {
    writeEmitter.fire("[Worker létrehozási hiba] " + (error?.stack || error?.message || String(error)) + "\r\n");
    return;
  }

  worker.onmessage = event => {
    const message = event.data || {};
    if (message.type === "output") {
      writeEmitter.fire(String(message.text || "").replace(/\n/g, "\r\n"));
    } else if (message.type === "stdinRequest") {
      waitingForInput = true;
      flushInput();
    } else if (message.type === "done") {
      if (message.ok) writeEmitter.fire("\r\n[Process exited with code 0]\r\n");
      else writeEmitter.fire("\r\n" + message.error + "\r\n[Process exited with code 1]\r\n");
      worker.terminate();
    } else if (message.ready) {
      writeEmitter.fire("[Pyodide] Runtime kész.\r\n");
    } else if (message.error && message.id === 0) {
      writeEmitter.fire("\r\n[Pyodide hiba] " + message.error + "\r\n");
    }
  };

  worker.onerror = event => {
    writeEmitter.fire("\r\n[Worker hiba] " + (event.message || "ismeretlen hiba") + "\r\n");
  };

  worker.onmessageerror = () => {
    writeEmitter.fire("\r\n[Worker üzenethiba]\r\n");
  };

  writeEmitter.fire("[Pyodide] Futtatás indítása…\r\n");
  worker.postMessage({ type: "runInteractive", code });
}

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("pythonline.runPythonFile", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error("Nincs megnyitott Python fájl.");
        await executeInteractive(context, editor.document.getText(), editor.document.fileName.split("/").pop());
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
        await executeInteractive(context, editor.document.getText(editor.selection), editor.document.fileName.split("/").pop() + " (selection)");
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
