const vscode = require("vscode");

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = "https://cdn.jsdelivr.net/npm/pyodide@" + PYODIDE_VERSION + "/";
const DB_NAME = "pythonline-pyodide";
const DB_VERSION = 1;
const STORE = "state";

let runtimePromise;
let installed = new Set();
let runTerminal;
let runWriteEmitter;
let runPtyOpen = false;
let activeRun = null;
let pythonWorker = null;
let pythonWorkerReady = false;
let pythonWorkerBlobUrl = null;

async function warmupPythonWorker(context) {
  if (pythonWorker) return;

  const workerUrl = vscode.Uri.joinPath(context.extensionUri, "worker.js").toString(true);
  try {
    const worker = await createPythonWorker(workerUrl);
    if (pythonWorker) {
      worker.terminate();
      return;
    }

    pythonWorker = worker;
    pythonWorkerReady = false;

    worker.onmessage = event => {
      const message = event.data || {};
      if (message.ready) {
        pythonWorkerReady = true;
      }
    };

    worker.onerror = event => {
      if (pythonWorker === worker) {
        pythonWorker = null;
        pythonWorkerReady = false;
      }
      if (pythonWorkerBlobUrl) {
        URL.revokeObjectURL(pythonWorkerBlobUrl);
        pythonWorkerBlobUrl = null;
      }
      console.warn("Pyodide worker warmup failed", event.message || event);
    };

    worker.onmessageerror = () => {
      if (pythonWorker === worker) {
        pythonWorker = null;
        pythonWorkerReady = false;
      }
      if (pythonWorkerBlobUrl) {
        URL.revokeObjectURL(pythonWorkerBlobUrl);
        pythonWorkerBlobUrl = null;
      }
      console.warn("Pyodide worker warmup message error");
    };
  } catch (error) {
    console.warn("Pyodide worker warmup failed", error);
  }
}

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

async function collectPythonFiles(uri, basePath = "") {
  const files = [];
  const entries = await vscode.workspace.fs.readDirectory(uri);
  for (const [name, type] of entries) {
    const child = vscode.Uri.joinPath(uri, name);
    const relative = basePath ? basePath + "/" + name : name;
    if (type === vscode.FileType.Directory) {
      files.push(...await collectPythonFiles(child, relative));
    } else if (type === vscode.FileType.File && name.endsWith(".py")) {
      const bytes = await vscode.workspace.fs.readFile(child);
      files.push({ path: "/workspace/" + relative, bytes: Array.from(bytes) });
    }
  }
  return files;
}

async function collectPythonWorkspace() {
  return collectPythonFiles(vscode.Uri.parse("pythonline:/workspace"));
}

async function collectBrowserWorkspaceEntries() {
  const entries = [];

  async function walk(uri) {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        entries.push({ path: child.path, type: "directory" });
        await walk(child);
      } else if (type === vscode.FileType.File) {
        entries.push({ path: child.path, type: "file", data: Array.from(await vscode.workspace.fs.readFile(child)) });
      }
    }
  }

  await walk(vscode.Uri.parse("pythonline:/workspace"));
  return entries;
}

async function syncWorkspaceFromPython(entries) {
  const normalized = new Map((entries || []).map(entry => [entry.path, entry]));
  const existing = await collectBrowserWorkspaceEntries();

  for (const entry of [...normalized.values()].filter(entry => entry.type === "directory").sort((a, b) => a.path.length - b.path.length)) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.parse("pythonline:" + entry.path));
  }

  for (const entry of normalized.values()) {
    if (entry.type !== "file") continue;
    await vscode.workspace.fs.writeFile(vscode.Uri.parse("pythonline:" + entry.path), new Uint8Array(entry.data || []));
  }

  const toDelete = existing.filter(entry => !normalized.has(entry.path));
  for (const entry of toDelete.filter(entry => entry.type === "file")) {
    await vscode.workspace.fs.delete(vscode.Uri.parse("pythonline:" + entry.path));
  }
  for (const entry of toDelete.filter(entry => entry.type === "directory").sort((a, b) => b.path.length - a.path.length)) {
    await vscode.workspace.fs.delete(vscode.Uri.parse("pythonline:" + entry.path), { recursive: true });
  }
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

async function createPythonWorker(workerUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(workerUrl, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("worker.js betöltése 15 másodperc után időtúllépéssel leállt");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error("worker.js HTTP " + response.status);
  }

  const source = await response.text();
  if (!source.trim()) {
    throw new Error("worker.js üres választ adott");
  }

  const blob = new Blob([source], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const worker = new Worker(blobUrl);
    pythonWorkerBlobUrl = blobUrl;
    return worker;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

async function executeInteractive(context, code, fileName, filePath) {
  if (activeRun && !activeRun.finished) {
    activeRun.closed = true;
    activeRun.worker?.terminate();
    if (activeRun.worker === pythonWorker) {
      pythonWorker = null;
      pythonWorkerReady = false;
    }
  }

  // Keep the same Run terminal between executions. The PTY forwards input to
  // activeRun, so replacing activeRun is enough to run a new program in the
  // already-open terminal without recreating it.
  if (!runTerminal) {
    runWriteEmitter = new vscode.EventEmitter();
    runPtyOpen = false;
  }

  const inputQueue = [];
  let inputLine = "";
  let waitingForInput = false;
  let worker;
  let closed = false;

  let inputBuffer = null;
  let inputControl = null;
  let inputBytes = null;
  if (typeof SharedArrayBuffer === "function") {
    inputBuffer = new SharedArrayBuffer(8 + 65536);
    inputControl = new Int32Array(inputBuffer, 0, 2);
    inputBytes = new Uint8Array(inputBuffer, 8);
  }

  const writeEmitter = runWriteEmitter;
  const pendingOutput = [];

  const write = text => {
    if (runPtyOpen) writeEmitter.fire(text);
    else pendingOutput.push(text);
  };

  function flushInput() {
    if (closed || !waitingForInput || !inputQueue.length) return;
    const line = inputQueue.shift();
    waitingForInput = false;

    if (!inputControl || !inputBytes) {
      write("\r\n[Input hiba] A böngésző nem támogatja a SharedArrayBuffer input csatornát.\r\n");
      return;
    }

    const bytes = new TextEncoder().encode(line);
    if (bytes.length > inputBytes.length) {
      write("\r\n[Input hiba] A bemenet túl hosszú.\r\n");
      return;
    }

    inputBytes.fill(0);
    inputBytes.set(bytes);
    Atomics.store(inputControl, 1, bytes.length);
    Atomics.store(inputControl, 0, 1);
    Atomics.notify(inputControl, 0, 1);
  }

  activeRun = {
    worker: pythonWorker,
    closed: false,
    finished: false,
    inputQueue,
    get inputLine() { return inputLine; },
    set inputLine(value) { inputLine = value; },
    write,
    flushInput
  };

  if (!runTerminal) {
    const pty = {
      onDidWrite: writeEmitter.event,
      open: () => {
        runPtyOpen = true;
        for (const text of pendingOutput.splice(0)) writeEmitter.fire(text);
      },
      close: () => {
        // The transient Run terminal is disposed when starting the next run.
        // Do not kill the persistent Pyodide worker after a completed run;
        // otherwise the next Run would reuse a terminated Worker and wait
        // forever at "Pyodide betöltése…".
        if (activeRun && !activeRun.finished) {
          activeRun.closed = true;
          if (activeRun.worker === pythonWorker) {
            activeRun.worker.terminate();
            pythonWorker = null;
            pythonWorkerReady = false;
            if (pythonWorkerBlobUrl) {
              URL.revokeObjectURL(pythonWorkerBlobUrl);
              pythonWorkerBlobUrl = null;
            }
          } else {
            activeRun.worker?.terminate();
          }
        }
      },
      handleInput: data => {
        const run = activeRun;
        if (!run || run.closed) return;

        for (const char of data) {
          if (char === "\r" || char === "\n") {
            run.write("\r\n");
            run.inputQueue.push(run.inputLine + "\n");
            run.inputLine = "";
            run.flushInput();
          } else if (char === "\x7f" || char === "\b") {
            if (run.inputLine.length) {
              run.inputLine = run.inputLine.slice(0, -1);
              run.write("\b \b");
            }
          } else if (char === "\x03") {
            run.write("^C\r\n");
            run.inputQueue.push("\x03");
            run.inputLine = "";
            run.flushInput();
          } else if (char >= " ") {
            run.inputLine += char;
            run.write(char);
          }
        }
      }
    };

    runTerminal = vscode.window.createTerminal({
      name: "Run: " + (fileName || "Python"),
      pty,
      isTransient: true
    });
  }

  runTerminal.show(true);
  write("\x1b[2J\x1b[H");

  let finishStartupProgress;
  let startupProgressReporter;
  const startupProgressDone = new Promise(resolve => {
    finishStartupProgress = resolve;
  });
  const startupProgress = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Pyodide" },
    async progress => {
      startupProgressReporter = progress;
      progress.report({ message: "Pyodide betöltése…" });
      await startupProgressDone;
    }
  );

  const workerUrl = vscode.Uri.joinPath(context.extensionUri, "worker.js").toString(true);
  try {
    if (!inputBuffer) {
      write("\r\n[Input hiba] A böngésző nem cross-origin isolated, ezért az interaktív input nem használható.\r\n");
      finishStartupProgress();
      return;
    }

    // Keep one Pyodide worker alive between runs. worker.js starts loading
    // Pyodide immediately at worker startup, so creating a new worker for
    // every Run can race CDN/IndexedDB loading and intermittently fail.
    if (!pythonWorker) {
      pythonWorker = await createPythonWorker(workerUrl);
      pythonWorkerReady = false;
    }

    worker = pythonWorker;
    activeRun.worker = worker;
    worker.postMessage({ type: "init", inputBuffer });
  } catch (error) {
    write("\r\n[Worker hiba] " + (error?.stack || error?.message || String(error)) + "\r\n");
    return;
  }

  await new Promise(resolve => {
    const finish = () => resolve();
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === "status") {
        if (message.text) startupProgressReporter?.report({ message: message.text });
        return;
      }
      if (message.ready) {
        pythonWorkerReady = true;
        (async () => {
          try {
            const files = await collectPythonWorkspace();
            worker.postMessage({ type: "syncFiles", files });
          } catch (error) {
            write("\r\n[Workspace sync hiba] " + (error?.message || String(error)) + "\r\n");
            worker.postMessage({ type: "syncFiles", files: [] });
          }
        })();
        return;
      }
      if (message.type === "syncReady") {
        finishStartupProgress();
        worker.postMessage({ type: "runInteractive", code, filePath, inputBuffer });
        return;
      }
      if (message.type === "done") {
        if (activeRun?.worker === worker) activeRun.finished = true;
        if (message.ok) write("\r\n[Process exited with 0]\r\n");
        else write("\r\n" + message.error + "\r\n[Process exited with 1]\r\n");
        worker.postMessage({ type: "snapshotWorkspace" });
        return;
      }
      if (message.type === "workspaceSnapshot") {
        (async () => {
          if (message.error) {
            write("\r\n[Workspace sync hiba] " + message.error + "\r\n");
          } else {
            try {
              await syncWorkspaceFromPython(message.entries);
            } catch (error) {
              write("\r\n[Workspace sync hiba] " + (error?.stack || error?.message || String(error)) + "\r\n");
            }
          }
          // Keep the worker alive so the next Run reuses the already
          // initialized Pyodide runtime instead of loading worker.js/Pyodide again.
          if (activeRun?.worker === worker) activeRun.worker = worker;
          finish();
        })();
        return;
      }
      if (message.type === "output") {
        write(String(message.text || "").replace(/\n/g, "\r\n"));
      } else if (message.type === "stdinRequest") {
        waitingForInput = true;
        flushInput();
      }
    };
    worker.onerror = event => {
      pythonWorker = null;
      pythonWorkerReady = false;
      if (pythonWorkerBlobUrl) {
      URL.revokeObjectURL(pythonWorkerBlobUrl);
      pythonWorkerBlobUrl = null;
    }
    if (activeRun?.worker === worker) activeRun.worker = null;
      finishStartupProgress();
      write("\r\n[Worker hiba] " + (event.message || "ismeretlen hiba") + "\r\n");
      finish();
    };
    worker.onmessageerror = () => {
      pythonWorker = null;
      pythonWorkerReady = false;
      if (pythonWorkerBlobUrl) {
      URL.revokeObjectURL(pythonWorkerBlobUrl);
      pythonWorkerBlobUrl = null;
    }
    if (activeRun?.worker === worker) activeRun.worker = null;
      finishStartupProgress();
      write("\r\n[Worker üzenethiba]\r\n");
      finish();
    };

    // A reused worker has already emitted its one-time ready message.
    // Start the per-run workspace sync explicitly in that case.
    if (pythonWorkerReady) {
      (async () => {
        try {
          const files = await collectPythonWorkspace();
          worker.postMessage({ type: "syncFiles", files });
        } catch (error) {
          write("\r\n[Workspace sync hiba] " + (error?.message || String(error)) + "\r\n");
          worker.postMessage({ type: "syncFiles", files: [] });
        }
      })();
    }
  });
  await startupProgress;
}

async function activate(context) {
  // Start the worker immediately when the extension activates. The worker
  // loads Pyodide in the background and stays alive for subsequent Runs.
  void warmupPythonWorker(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonline.runPythonFile", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error("Nincs megnyitott Python fájl.");
        await vscode.workspace.saveAll();
        await executeInteractive(context, editor.document.getText(), editor.document.fileName.split("/").pop(), editor.document.uri.path);
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
        await executeInteractive(context, editor.document.getText(editor.selection), editor.document.fileName.split("/").pop() + " (selection)", editor.document.uri.path);
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
