const vscode = require('vscode');

const WASI_SH = 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/';
const ROOT = vscode.Uri.parse('pythonline:/workspace');
let extensionUri;
const terminals = new Set();

function rootUri(path = '/') { return ROOT.with({ path: path || '/' }); }

async function collectTree(path = '/workspace', files = {}, directories = []) {
  const entries = await vscode.workspace.fs.readDirectory(rootUri(path));
  if (path !== '/workspace') directories.push(path);
  for (const [name, type] of entries) {
    const child = path === '/workspace' ? '/workspace/' + name : path + '/' + name;
    if (type === vscode.FileType.Directory) await collectTree(child, files, directories);
    else if (type === vscode.FileType.File) files[child] = await vscode.workspace.fs.readFile(rootUri(child));
  }
  return { files, directories };
}

function nativeImport(url) { return Function('url', 'return import(url)')(url); }

async function loadWasi() {
  const [spawnMod] = await Promise.all([nativeImport(WASI_SH + 'spawn.mjs')]);
  return { spawn: spawnMod.spawn };
}

async function readProviderTree(path = '/workspace', out = new Map()) {
  out.set(path, 'dir');
  for (const [name, type] of await vscode.workspace.fs.readDirectory(rootUri(path))) {
    const child = path === '/workspace' ? '/workspace/' + name : path + '/' + name;
    if (type === vscode.FileType.Directory) await readProviderTree(child, out);
    else if (type === vscode.FileType.File) out.set(child, await vscode.workspace.fs.readFile(rootUri(child)));
  }
  return out;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function syncDump(state, dump) {
  const current = await readProviderTree();
  const wanted = new Map([['/workspace', 'dir']]);
  for (const dir of dump.directories || []) wanted.set(dir, 'dir');
  for (const file of dump.files || []) wanted.set(file.path, new Uint8Array(file.data));

  for (const path of [...current.keys()]
    .filter(path => path !== '/workspace' && !wanted.has(path))
    .sort((a,b) => b.length - a.length)) {
    try { await vscode.workspace.fs.delete(rootUri(path), { recursive: true, useTrash: false }); } catch {}
  }

  for (const path of [...wanted.entries()]
    .filter(([,v]) => v === 'dir')
    .map(([p]) => p)
    .sort((a,b) => a.length - b.length)) {
    if (!current.has(path)) {
      try { await vscode.workspace.fs.createDirectory(rootUri(path)); } catch {}
    }
  }

  for (const [path, value] of wanted) {
    if (value === 'dir') continue;
    if (!sameBytes(current.get(path), value)) {
      await vscode.workspace.fs.writeFile(rootUri(path), value);
    }
  }
}

function createWorker(url, onReady) {
  const worker = new Worker(vscode.Uri.joinPath(extensionUri, 'busybox-worker-bootstrap.js').toString(true));
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      if (event.data?.type === 'worker-bootstrap-ready') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (onReady) onReady(worker);
        resolve(worker);
      } else if (event.data?.type === 'worker-bootstrap-error') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(new Error(event.data.message || 'BusyBox worker bootstrap failed'));
      }
    };
    const onError = event => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(event.message || 'BusyBox worker bootstrap failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'load', url });
  });
}

function createPty() {
  const output = new vscode.EventEmitter();
  const state = {
    output,
    session: undefined,
    shellWorker: undefined,
    writerWorker: undefined,
    syncTimer: undefined,
    dumpPending: false,
    closed: false
  };

  const scheduleSync = () => {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => requestDump(state), 300);
  };

  return {
    onDidWrite: output.event,

    open() {
      void createSession(state, scheduleSync).catch(error => {
        if (!state.closed) output.fire(
          '\r\nFailed to start BusyBox: ' + (error?.message || String(error)) + '\r\n'
        );
      });
    },

    close() {
      state.closed = true;
      clearTimeout(state.syncTimer);
      try { state.session?.terminate(); } catch {}
      try { state.shellWorker?.terminate(); } catch {}
      try { state.writerWorker?.terminate(); } catch {}
    },

    handleInput(data) {
      if (!state.session || state.closed) return;
      state.session.write(data);
      if (data.includes('\x03')) state.session.interrupt();
    }
  };
}

function requestDump(state) {
  if (state.closed || !state.writerWorker || state.dumpPending) return;
  state.dumpPending = true;
  state.writerWorker.postMessage({ type: 'dump' });
}

async function createSession(state, scheduleSync) {
  state.output.fire('\r\n[BusyBox] initializing...\r\n');

  const browserFs = vscode.extensions.getExtension('Pandorka132.pythonline-browser-fs');
  if (browserFs) await browserFs.activate();

  state.output.fire('[BusyBox] loading WASI-SH...\r\n');
  const { spawn } = await loadWasi();
  state.output.fire('[BusyBox] WASI-SH loaded\r\n');

  const tree = await collectTree();
  const writerUrl = vscode.Uri.joinPath(extensionUri, 'busybox-writer.mjs').toString(true);
  const shellUrl = vscode.Uri.joinPath(extensionUri, 'busybox-worker.mjs').toString(true);

  state.output.fire('[BusyBox] starting filesystem worker...\r\n');
  state.writerWorker = await createWorker(writerUrl);
  state.writerWorker.addEventListener('message', async event => {
    const data = event.data;
    if (data?.type === 'ready') {
      state.output.fire('[BusyBox] filesystem worker ready\r\n');
      if (state.shellWorker) {
        state.shellWorker.postMessage({ type: 'store', sab: data.sab, snapshot: data.snapshot });
      }
      scheduleSync();
    } else if (data?.type === 'dump') {
      state.dumpPending = false;
      try { await syncDump(state, data); } catch (error) {
        if (!state.closed) state.output.fire('[BusyBox sync] ' + (error?.message || String(error)) + '\r\n');
      }
    } else if (data?.type === 'error') {
      state.dumpPending = false;
      if (!state.closed) state.output.fire('[BusyBox writer] ' + data.message + '\r\n');
    }
  });

  state.output.fire('[BusyBox] starting shell worker...\r\n');
  state.shellWorker = await createWorker(shellUrl);
  state.shellWorker.addEventListener('error', event => {
    if (!state.closed) state.output.fire('\r\n[BusyBox worker] ' + (event.message || 'worker error') + '\r\n');
  });

  state.writerWorker.postMessage({ type: 'init', files: tree.files, directories: tree.directories });

  state.session = await spawn({
    worker: state.shellWorker,
    tty: true,
    env: { HOME: '/workspace', PS1: '\\[\\033[32m\\]\\w\\[\\033[0m\\] $ ' }
  });

  state.output.fire('[BusyBox] shell started\r\n');
  state.session.onOutput(bytes => state.output.fire(new TextDecoder().decode(bytes).replace(/\n/g, '\r\n')));
  state.session.onError(error => {
    if (!state.closed) state.output.fire('\r\n[BusyBox] ' + (error?.message || String(error)) + '\r\n');
  });
  state.session.onExit(code => {
    if (!state.closed) state.output.fire('\r\n[BusyBox exited: ' + code + ']\r\n');
  });

  state.session.write('cd /workspace\n');
}

async function activate(context) {
  extensionUri = context.extensionUri;

  context.subscriptions.push(vscode.window.registerTerminalProfileProvider('pythonline.busybox', {
    provideTerminalProfile() {
      return { options: { name: 'BusyBox', pty: createPty() } };
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('busybox.open', () => {
    const terminal = vscode.window.createTerminal({ name: 'BusyBox', pty: createPty() });
    terminals.add(terminal);
    context.subscriptions.push(terminal.onDidClose(() => terminals.delete(terminal)));
    terminal.show();
  }));
}

module.exports = { activate };
