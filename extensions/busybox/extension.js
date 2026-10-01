const vscode = require('vscode');

const WASI_SH = 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/';
const ROOT = vscode.Uri.parse('pythonline:/workspace');

let terminal;
let terminalPty;
let terminalOutput;
let session;
let worker;
let writer;
let backing;
let syncTimer;
let syncing = false;
let syncAgain = false;
let extensionUri;

function rootUri(path = '/') {
  return ROOT.with({ path: path || '/' });
}

async function collectTree(path = '/workspace', files = {}, directories = []) {
  const entries = await vscode.workspace.fs.readDirectory(rootUri(path));
  if (path !== '/workspace') directories.push(path);
  for (const [name, type] of entries) {
    const child = path === '/workspace' ? '/workspace/' + name : path + '/' + name;
    if (type === vscode.FileType.Directory) {
      await collectTree(child, files, directories);
    } else if (type === vscode.FileType.File) {
      files[child] = await vscode.workspace.fs.readFile(rootUri(child));
    }
  }
  return { files, directories };
}

function nativeImport(url) {
  // VS Code's web extension loader rewrites a normal dynamic import() into
  // importScripts(). That is invalid for ESM, so keep this import native.
  return Function('url', 'return import(url)')(url);
}

async function loadWasi() {
  const [spawnMod, fsMod] = await Promise.all([
    nativeImport(WASI_SH + 'spawn.mjs'),
    nativeImport(WASI_SH + 'fs.mjs')
  ]);
  return {
    spawn: spawnMod.spawn,
    memoryFs: fsMod.memoryFs,
    journalWriter: fsMod.journalWriter
  };
}

async function readProviderTree(path = '/workspace', out = new Map()) {
  out.set(path, 'dir');
  for (const [name, type] of await vscode.workspace.fs.readDirectory(rootUri(path))) {
    const child = path === '/workspace' ? '/workspace/' + name : path + '/' + name;
    if (type === vscode.FileType.Directory) {
      await readProviderTree(child, out);
    } else if (type === vscode.FileType.File) {
      out.set(child, await vscode.workspace.fs.readFile(rootUri(child)));
    }
  }
  return out;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function flushStoreToWorkspace() {
  if (!writer?.store) return;
  if (syncing) {
    syncAgain = true;
    return;
  }

  syncing = true;
  try {
    const current = await readProviderTree();
    const wanted = new Map();

    async function walk(path) {
      const stat = writer.store.statSync(path);
      const isDir = (stat.mode & 0o170000) === 0o040000;
      if (isDir) {
        wanted.set(path, 'dir');
        for (const name of writer.store.readdirSync(path)) {
          await walk(path === '/' ? '/' + name : path + '/' + name);
        }
      } else {
        const data = new Uint8Array(stat.size);
        if (stat.size) writer.store.readSync(path, data, 0, stat.size);
        wanted.set(path, data);
      }
    }

    await walk('/workspace');

    const pathsToDelete = [...current.keys()]
      .filter(path => path !== '/workspace' && !wanted.has(path))
      .sort((a, b) => b.length - a.length);

    for (const path of pathsToDelete) {
      await vscode.workspace.fs.delete(rootUri(path), { recursive: true, useTrash: false });
    }

    const dirs = [...wanted.entries()]
      .filter(([, value]) => value === 'dir')
      .map(([path]) => path)
      .sort((a, b) => a.length - b.length);

    for (const path of dirs) {
      if (!current.has(path)) {
        try {
          await vscode.workspace.fs.createDirectory(rootUri(path));
        } catch {}
      }
    }

    for (const [path, value] of wanted) {
      if (value === 'dir') continue;
      const old = current.get(path);
      if (!sameBytes(old, value)) {
        await vscode.workspace.fs.writeFile(rootUri(path), value);
      }
    }
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync();
    }
  }
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void flushStoreToWorkspace(), 250);
}

function patchWriterStore(store) {
  const mutating = new Set([
    'createFileSync',
    'mkdirSync',
    'rmdirSync',
    'unlinkSync',
    'renameSync',
    'linkSync',
    'writeSync',
    'touchSync'
  ]);

  for (const name of mutating) {
    const original = store[name];
    if (typeof original !== 'function') continue;
    store[name] = function (...args) {
      const result = original.apply(this, args);
      scheduleSync();
      return result;
    };
  }
}

async function createSession() {
  const { spawn, memoryFs, journalWriter } = await loadWasi();

  const tree = await collectTree();
  const files = {};
  for (const [path, data] of Object.entries(tree.files)) {
    files[path] = data;
  }

  backing = memoryFs(files);

  try {
    backing.mkdirSync('/workspace');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  for (const dir of tree.directories.sort((a, b) => a.length - b.length)) {
    try {
      backing.mkdirSync(dir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  writer = await journalWriter(backing);
  if (writer.ready) await writer.ready;
  if (!writer.store) {
    throw new Error('wasi-sh journal writer did not expose its store');
  }

  patchWriterStore(writer.store);

  const workerUrl = vscode.Uri.joinPath(
    extensionUri,
    'busybox-worker.mjs'
  ).toString(true);

  // VS Code's web extension Worker shim loads extension workers through
  // importScripts(), which cannot load an ESM worker. Start a classic worker
  // instead and let that worker perform a native dynamic import() of our ESM
  // entrypoint. The imported module keeps its normal relative imports.
  const workerBootstrap = [
    'import(' + JSON.stringify(workerUrl) + ').then(() => {',
    '  self.postMessage({ type: "worker-bootstrap-ready" });',
    '}).catch((error) => {',
    '  self.postMessage({ type: "worker-bootstrap-error",',
    '    message: error?.stack || error?.message || String(error) });',
    '});'
  ].join('\n');

  const workerBlob = new Blob([workerBootstrap], { type: 'text/javascript' });
  const workerBlobUrl = URL.createObjectURL(workerBlob);

  worker = new Worker(workerBlobUrl);

  await new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data?.type === 'worker-bootstrap-ready') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve();
      } else if (event.data?.type === 'worker-bootstrap-error') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(new Error(event.data.message || 'BusyBox worker bootstrap failed'));
      }
    };
    const onError = (event) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(event.message || 'BusyBox worker bootstrap failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });

  worker.addEventListener('error', (event) => {
    terminalOutput.fire(
      '\\r\\n[BusyBox worker] ' + (event.message || 'worker error') + '\\r\\n'
    );
  });

  worker.onerror = (event) => {
    terminalOutput.fire(
      '\\r\\n[BusyBox worker] ' + (event.message || 'worker error') + '\\r\\n'
    );
  };

  worker.postMessage({
    type: 'store',
    sab: writer.sab,
    snapshot: writer.snapshot
  });

  session = await spawn({
    worker,
    tty: true,
    env: {
      HOME: '/workspace',
      PS1: '\\[\\033[32m\\]\\w\\[\\033[0m\\] $ '
    }
  });

  session.onOutput((bytes) => {
    terminalOutput.fire(
      new TextDecoder().decode(bytes).replace(/\n/g, '\r\n')
    );
  });

  session.onError((error) => {
    terminalOutput.fire(
      '\r\n[BusyBox] ' + (error?.message || String(error)) + '\r\n'
    );
  });

  session.onExit((code) => {
    terminalOutput.fire('\r\n[BusyBox exited: ' + code + ']\r\n');
  });

  session.write('cd /workspace\n');
}

function createPty() {
  terminalOutput = new vscode.EventEmitter();

  return {
    onDidWrite: terminalOutput.event,

    open() {
      void createSession().catch((error) => {
        terminalOutput.fire(
          '\r\nFailed to start BusyBox: ' +
          (error?.message || String(error)) +
          '\r\n'
        );
      });
    },

    close() {
      try { session?.terminate(); } catch {}
      try { worker?.terminate(); } catch {}
      session = undefined;
      worker = undefined;
    },

    handleInput(data) {
      if (!session) return;
      session.write(data);
      if (data.includes('\x03')) session.interrupt();
    }
  };
}

async function activate(context) {
  extensionUri = context.extensionUri;

  context.subscriptions.push(
    vscode.commands.registerCommand('busybox.open', () => {
      if (!terminal) {
        terminalPty = createPty();

        terminal = vscode.window.createTerminal({
          name: 'BusyBox',
          pty: terminalPty
        });

        terminal.show();
        context.subscriptions.push(terminal);
      } else {
        terminal.show();
      }
    })
  );

  await vscode.commands.executeCommand('busybox.open');
}

module.exports = { activate };
