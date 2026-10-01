const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = "https://cdn.jsdelivr.net/npm/pyodide@" + PYODIDE_VERSION + "/";
let pyodidePromise;
let installed = new Set();

async function runtime() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const mod = await import(INDEX_URL + "pyodide.mjs");
      const pyodide = await mod.loadPyodide({ indexURL: INDEX_URL });
      const saved = JSON.parse(localStorage.getItem("pythonline-pyodide-packages") || "[]");
      if (saved.length) {
        await pyodide.loadPackage("micropip");
        for (const spec of saved) {
          try {
            await pyodide.runPythonAsync("import micropip\nawait micropip.install(" + JSON.stringify(spec) + ")");
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

async function installPackage(spec) {
  const pyodide = await runtime();
  await pyodide.loadPackage("micropip");
  await pyodide.runPythonAsync("import micropip\nawait micropip.install(" + JSON.stringify(spec) + ")");
  installed.add(spec);
  localStorage.setItem("pythonline-pyodide-packages", JSON.stringify([...installed].sort()));
  return true;
}

async function listPackages() {
  const pyodide = await runtime();
  const result = pyodide.runPython(
    "import importlib.metadata; [(d.metadata['Name'], d.version) for d in importlib.metadata.distributions()]"
  );
  return result.toJs();
}

self.onmessage = async event => {
  const { id, type } = event.data;
  try {
    let result;
    if (type === "run") result = await runPython(event.data.code);
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
