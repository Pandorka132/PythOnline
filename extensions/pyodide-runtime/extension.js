const vscode = require("vscode");

let runtimePromise;

function getRuntime(context) {
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const worker = new Worker(vscode.Uri.joinPath(context.extensionUri, "worker.js").toString());
      const pending = new Map();
      let nextId = 1;

      const call = (type, payload = {}) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        worker.postMessage({ id, type, ...payload });
      });

      worker.onmessage = event => {
        const message = event.data;
        if (message.ready) {
          resolve({
            run: code => call("run", { code }),
            install: spec => call("install", { spec }),
            version: () => call("version"),
            packages: () => call("packages")
          });
          return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.error) item.rej(new Error(message.error));
        else item.res(message.result);
      };

      worker.onerror = event => reject(new Error(event.message || "Pyodide worker failed"));
    });
  }
  return runtimePromise;
}

async function runCode(context, code) {
  const runtime = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Pyodide indítása…" },
    () => getRuntime(context)
  );
  const result = await runtime.run(code);
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
        await runCode(context, editor.document.getText());
      } catch (error) {
        vscode.window.showErrorMessage("Python futtatási hiba: " + error.message);
      }
    }),
    vscode.commands.registerCommand("pythonline.runPythonSelection", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) throw new Error("Jelölj ki egy Python kódrészletet.");
        await runCode(context, editor.document.getText(editor.selection));
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
        const runtime = await getRuntime(context);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Telepítés: " + spec },
          () => runtime.install(spec)
        );
        vscode.window.showInformationMessage("Telepítve: " + spec);
      } catch (error) {
        vscode.window.showErrorMessage("Csomagtelepítési hiba: " + error.message);
      }
    }),
    vscode.commands.registerCommand("pythonline.showPythonRuntime", async () => {
      try {
        const runtime = await getRuntime(context);
        const version = await runtime.version();
        const packages = await runtime.packages();
        vscode.window.showInformationMessage("Pyodide " + version + " — " + packages.length + " telepített csomag");
      } catch (error) {
        vscode.window.showErrorMessage("Pyodide hiba: " + error.message);
      }
    })
  );
}

module.exports = { activate };
