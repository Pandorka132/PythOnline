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

function createInteractiveInput() {
  return new Promise(resolve => {
    self.__pyodideInputResolver = resolve;
    self.postMessage({ type: "stdinRequest" });
  });
}

async function runInteractive(code) {
  self.postMessage({ type: "output", stream: "stdout", text: "[Pyodide] Runtime betöltése…\\n" });
  const pyodide = await runtime();
  self.postMessage({ type: "output", stream: "stdout", text: "[Pyodide] Runtime betöltve.\\n" });

  self.__pyodideInputResolver = null;
  self.__pyodideReadLine = createInteractiveInput;

  pyodide.setStdout({ batched: text => self.postMessage({ type: "output", stream: "stdout", text }) });
  pyodide.setStderr({ batched: text => self.postMessage({ type: "output", stream: "stderr", text }) });

  await pyodide.runPythonAsync(`
from pyodide.ffi import run_sync
from js import __pyodideReadLine
import builtins

def _pyodide_input(prompt=""):
    if prompt:
        print(prompt, end="", flush=True)
    return str(run_sync(__pyodideReadLine()))

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

self.onmessage = async event => {
  const { id, type } = event.data;

  if (type === "stdin") {
    const resolver = self.__pyodideInputResolver;
    self.__pyodideInputResolver = null;
    resolver?.(String(event.data.data ?? ""));
    return;
  }

  try {
    let result;
    if (type === "run") result = await runPython(event.data.code);
    else if (type === "runInteractive") result = await runInteractive(event.data.code);
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
