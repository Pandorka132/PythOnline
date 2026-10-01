const vscode = require('vscode');

const WASI_SH = 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/';
const ROOT = vscode.Uri.parse('pythonline:/workspace');

let terminal;
let session;
let worker;
let writer;
let backing;
let syncTimer;
let syncing = false;
let syncAgain = false;

function rootUri(path = '/') {
  return ROOT.with({ path: path || '/' });
}

function toShellPath(path) {
  if (path === '/workspace') return '/workspace';
  if (path.startsWith('/workspace/')) return path;
  return '/workspace' + (path.startsWith('/') ? path : '/' + path);
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

function makeBackend(files, directories) {
  const store = new backingMemoryFs(files);
  for (const dir of directories.sort((a, b) => a.length - b.length)) {
    try {
      store.mkdirSync(dir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return store;
}

async function loadWasi() {
  const [spawnMod, fsMod] = await Promise.all([
    import(WASI_SH + 'spawn.mjs'),
    import(WASI_SH + 'fs.mjs')
  ]);
  return { spawn: spawnMod.spawn, memoryFs: fsMod.memoryFs, journalWriter: fsMod.journalWriter };
}

let backingMemoryFs;

async function writeStoreTree(store, path = '/workspace', seen = new Set()) {
  const normalized = path === '/workspace' ? '/workspace' : path;
  seen.add(normalized);
  const stat = store.statSync(normalized);
  if ((stat.mode & 0o170000) === 0o040000) {
    for (const name of store.readdirSync(normalized)) {
      await writeStoreTree(store, normalized === '/' ? '/' + name : normalized + '/' + name, seen);
    }
  }
}

async function readProviderTree(path = '/workspace', out = new Map()) {
  out.set(path, 'dir');
  for (const [name, type] of await vscode.workspace.fs.readDirectory(rootUri(path))) {
    const child = path === '/workspace' ? '/workspace/' + name : path + '/' + name;
    if (type === vscode.FileType.Directory) {
      await readProviderTree(child, out);
    } else if (type === vscode.FileType.File) {
      const bytes = await vscode.workspace.fs.readFile(rootUri(child));
      out.set(child, bytes);
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
    'createFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync',
    'renameSync', 'linkSync', 'writeSync', 'touchSync'
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
  backingMemoryFs = memoryFs;

  const tree = await collectTree();
  const files = {};
  for (const [path, data] of Object.entries(tree.files)) files[path] = data;
  backing = memoryFs(files);
  for (const dir of tree.directories.sort((a, b) => a.length - b.length)) {
    try {
      backing.mkdirSync(dir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  writer = await journalWriter(backing);
  if (writer.ready) await writer.ready;
  if (!writer.store) throw new Error('wasi-sh journal writer did not expose its store');
  patchWriterStore(writer.store);

  worker = new Worker(new URL('./busybox-worker.mjs', import.meta.url), { type: 'module' });
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
    terminalPty.fire(new TextDecoder().decode(bytes));
  });

  session.onError((error) => {
    terminalPty.fire('\r\n[BusyBox] ' + (error?.message || String(error)) + '\r\n');
  });

  session.onExit((code) => {
    terminalPty.fire('\r\n[BusyBox exited: ' + code + ']\r\n');
  });

  session.write('cd /workspace\\n');
}

function createPty() {
  terminalOutput = new vscode.EventEmitter();
  return {
    onDidWrite: terminalOutput.event,
    open() {
      terminalPty.fire = text => terminalOutput.fire(text);
      void createSession().catch(error => {
        terminalPty.fire('\r\nFailed to start BusyBox: ' + (error?.message || String(error)) + '\r\n');
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
  context.subscriptions.push(
    vscode.commands.registerCommand('pythonline.openTerminal', () => {
      if (!terminal) {
        terminalPty = createPty();
        terminal = vscode.window.createTerminal({
          name: 'PythOnline',
          pty: terminalPty
        });
        terminal.show();
        context.subscriptions.push(terminal);
      } else {
        terminal.show();
      }
    })
  );

  await vscode.commands.executeCommand('pythonline.openTerminal');
}

module.exports = { activate };
