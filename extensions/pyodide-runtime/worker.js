const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = "https://cdn.jsdelivr.net/npm/pyodide@" + PYODIDE_VERSION + "/";
const DB_NAME = "pythonline-pyodide";
const DB_VERSION = 1;
const STORE = "state";
let pyodidePromise;
let installed = new Set();

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadSavedPackages() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get("packages");
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error);
  });
}

async function savePackages(packages) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(packages, "packages");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const FILESYSTEM_DB = "pythonline-filesystem";
const FILESYSTEM_STORE = "entries";

function openFilesystemDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILESYSTEM_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILESYSTEM_STORE)) {
        request.result.createObjectStore(FILESYSTEM_STORE, { keyPath: "path" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open PythOnline filesystem"));
  });
}

function loadWorkspaceEntries() {
  return openFilesystemDb().then(db => new Promise((resolve, reject) => {
    const request = db.transaction(FILESYSTEM_STORE, "readonly")
      .objectStore(FILESYSTEM_STORE)
      .getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Could not read PythOnline filesystem"));
  }));
}

function normalizeWorkspacePath(path) {
  const raw = String(path || "").replace(/\\/g, "/");
  return raw.startsWith("/") ? raw : "/" + raw;
}

async function mountWorkspace(pyodide) {
  self.postMessage({ type: "status", text: "Workspace betöltése…" });
  const entries = await loadWorkspaceEntries();
  self.postMessage({ type: "status", text: "Workspace: " + entries.length + " elem" });

  try {
    pyodide.FS.mkdirTree("/workspace");
  } catch {}

  const directories = entries
    .filter(entry => entry.type === "directory" && entry.path !== "/workspace")
    .sort((a, b) => a.path.length - b.path.length);

  for (const entry of directories) {
    try {
      pyodide.FS.mkdirTree(normalizeWorkspacePath(entry.path));
    } catch {}
  }

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const path = normalizeWorkspacePath(entry.path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    try {
      pyodide.FS.mkdirTree(parent);
    } catch {}
    pyodide.FS.writeFile(path, new Uint8Array(entry.data || new ArrayBuffer(0)));
  }

  pyodide.runPython(
    "import os, sys; os.chdir('/workspace'); sys.path.insert(0, '/workspace') if '/workspace' not in sys.path else None"
  );
  self.postMessage({ type: "status", text: "Workspace kész" });
}

async function runtime() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const mod = await import(INDEX_URL + "pyodide.mjs");
      const pyodide = await mod.loadPyodide({ indexURL: INDEX_URL });
      const saved = await loadSavedPackages();
      if (saved.length) {
        await pyodide.loadPackage("micropip");
        for (const spec of saved) {
          try {
            await pyodide.runPythonAsync(
              "import micropip\nawait micropip.install(" + JSON.stringify(spec) + ")"
            );
            installed.add(spec);
          } catch (error) {
            console.warn("Failed to restore package", spec, error);
          }
        }
      }
      await mountWorkspace(pyodide);
      return pyodide;
    })();
  }
  return pyodidePromise;
}

async function runPython(code) {
  const pyodide = await runtime();
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

let inputControl = null;
let inputBytes = null;

function setupInteractiveInput(buffer) {
  if (!buffer) return;
  inputControl = new Int32Array(buffer, 0, 2);
  inputBytes = new Uint8Array(buffer, 8);
}

function createInteractiveInput() {
  if (!inputControl || !inputBytes) {
    throw new Error("Interactive input requires SharedArrayBuffer support.");
  }

  self.postMessage({ type: "stdinRequest" });

  // The worker may block here: the Run terminal's thread is the main thread,
  // which writes the answer into the shared buffer and wakes us with Atomics.notify().
  Atomics.wait(inputControl, 0, 0);

  const length = Atomics.load(inputControl, 1);
  // TextDecoder refuses SharedArrayBuffer-backed views. Copy the bytes into
  // a normal ArrayBuffer before decoding them.
  const text = new TextDecoder().decode(inputBytes.slice(0, length));

  Atomics.store(inputControl, 1, 0);
  Atomics.store(inputControl, 0, 0);
  return text;
}

async function runInteractive(code, filePath) {
  setupInteractiveInput(self.__pyodideInputBuffer);
  const scriptPath = normalizeWorkspacePath(filePath || "/workspace");
  const scriptDir = scriptPath.slice(0, scriptPath.lastIndexOf("/")) || "/workspace";
  const scriptDirLiteral = JSON.stringify(scriptDir);
  self.postMessage({ type: "status", text: "Pyodide betöltése…" });
  const pyodide = await runtime();
  pyodide.runPython("import os, sys; os.chdir('/workspace'); sys.path.insert(0, " + scriptDirLiteral + ") if " + scriptDirLiteral + " not in sys.path else None");
  self.postMessage({ type: "started" });

  self.__pyodideInputResolver = null;
  self.__pyodideReadLine = createInteractiveInput;

  // `input()` can block the Python coroutine before a line ending is emitted.
  // Use Pyodide's raw stream so prompts such as `input("Mi a neved? ")`
  // reach the Run terminal immediately, before waiting for stdin.
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  pyodide.setStdout({
    raw: byte => {
      const text = stdoutDecoder.decode(new Uint8Array([byte]), { stream: true });
      if (text) self.postMessage({ type: "output", stream: "stdout", text });
    }
  });
  pyodide.setStderr({
    raw: byte => {
      const text = stderrDecoder.decode(new Uint8Array([byte]), { stream: true });
      if (text) self.postMessage({ type: "output", stream: "stderr", text });
    }
  });

  // Keep normal Python input() semantics. The actual wait happens in this
  // worker using shared memory, so the UI/main thread remains responsive.
  await pyodide.runPythonAsync(`
from js import __pyodideReadLine
import builtins

def _pyodide_input(prompt=""):
    if prompt:
        print(prompt, end="", flush=True)
    return str(__pyodideReadLine())

builtins.input = _pyodide_input
`);

  try {
    const result = await pyodide.runPythonAsync(code);
    if (result !== undefined && result !== null) {
      self.postMessage({ type: "output", stream: "stdout", text: String(result) });
    }
    self.postMessage({ type: "done", ok: true });
  } catch (exception) {
    self.postMessage({
      type: "done",
      ok: false,
      error: exception && exception.stack ? exception.stack : String(exception)
    });
  }
}

async function syncFiles(files) {
  const pyodide = await runtime();
  for (const file of files || []) {
    const path = String(file.path || "");
    if (!path.startsWith("/workspace/") || !path.endsWith(".py")) continue;
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      try { pyodide.FS.mkdir(current); } catch {}
    }
    pyodide.FS.writeFile(path, new Uint8Array(file.bytes || []));
  }
  pyodide.runPython("import os, sys, importlib; os.chdir('/workspace'); sys.path.insert(0, '/workspace') if '/workspace' not in sys.path else None; importlib.invalidate_caches()");
}

function collectWorkspaceSnapshot(pyodide) {
  const entries = [];

  function walk(path) {
    let stat;
    try { stat = pyodide.FS.stat(path); } catch { return; }

    if (pyodide.FS.isDir(stat.mode)) {
      if (path !== "/workspace") entries.push({ path, type: "directory" });
      for (const name of pyodide.FS.readdir(path)) {
        if (name === "." || name === "..") continue;
        walk(path.replace(/\/$/, "") + "/" + name);
      }
      return;
    }

    if (pyodide.FS.isFile(stat.mode)) {
      entries.push({ path, type: "file", data: Array.from(pyodide.FS.readFile(path)) });
    }
  }

  walk("/workspace");
  return entries;
}

async function installPackage(spec) {
  const pyodide = await runtime();
  await pyodide.loadPackage("micropip");
  await pyodide.runPythonAsync(
    "import micropip\nawait micropip.install(" + JSON.stringify(spec) + ")"
  );
  installed.add(spec);
  await savePackages([...installed].sort());
  return true;
}

async function listPackages() {
  const pyodide = await runtime();
  return JSON.parse(pyodide.runPython(
    "import json, importlib.metadata; json.dumps([(d.metadata['Name'], d.version) for d in importlib.metadata.distributions()])"
  ));
}

function initInteractiveInput(buffer) {
  if (buffer) setupInteractiveInput(buffer);
}

self.onmessage = async event => {
  const { id, type } = event.data;

  if (type === "init") {
    initInteractiveInput(event.data.inputBuffer);
    return;
  }

  if (type === "stdin") {
    const resolver = self.__pyodideInputResolver;
    self.__pyodideInputResolver = null;
    resolver?.(String(event.data.data ?? ""));
    return;
  }

  if (type === "syncFiles") {
    try {
      await syncFiles(event.data.files);
      self.postMessage({ type: "syncReady" });
    } catch (error) {
      self.postMessage({ type: "syncReady", error: error && error.stack ? error.stack : String(error) });
    }
    return;
  }

  if (type === "snapshotWorkspace") {
    try {
      const pyodide = await runtime();
      self.postMessage({ type: "workspaceSnapshot", entries: collectWorkspaceSnapshot(pyodide) });
    } catch (error) {
      self.postMessage({ type: "workspaceSnapshot", error: error && error.stack ? error.stack : String(error) });
    }
    return;
  }

  try {
    let result;
    if (type === "run") result = await runPython(event.data.code);
    else if (type === "runInteractive") {
      initInteractiveInput(event.data.inputBuffer);
      result = await runInteractive(event.data.code, event.data.filePath);
    }
    else if (type === "install") result = await installPackage(event.data.spec);
    else if (type === "version") result = pyodideVersion(await runtime());
    else if (type === "packages") result = await listPackages();
    else throw new Error("Unknown request: " + type);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error && error.stack ? error.stack : String(error) });
  }
};

function pyodideVersion(pyodide) {
  return pyodide.runPython("import sys; sys.version");
}

runtime().then(() => self.postMessage({ ready: true })).catch(error => {
  self.postMessage({ ready: true });
  self.postMessage({ id: 0, error: error && error.stack ? error.stack : String(error) });
});
