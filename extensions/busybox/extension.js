const vscode = require('vscode');

const WASI_SH = 'https://cdn.jsdelivr.net/gh/alganet/wasi-sh@main/src/';
// Current wasi-sh sources provide tty/suspendInput; the generated WASM is still published in the npm package.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/dist/busybox.wasm';
const ROOT = vscode.Uri.parse('pythonline:/workspace');
let extensionUri;
const terminals = new Set();
let debugChannel;

function debug(message) {
  try {
    debugChannel?.appendLine(new Date().toISOString() + ' ' + message);
  } catch {}
}

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
    writerStore: undefined,
    syncTimer: undefined,
    dumpPending: false,
    closed: false,
    inputQueue: []
  };

  const scheduleSync = () => {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => requestDump(state), 300);
  };

  return {
    onDidWrite: output.event,

    open() {
      debug('PTY open()');
      void createSession(state, scheduleSync).catch(error => {
        debug('createSession FAILED: ' + (error?.stack || error?.message || String(error)));
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
      debug('handleInput: ' + JSON.stringify(data));
      if (state.closed) {
        debug('handleInput ignored: closed');
        return;
      }
      if (!state.session) {
        debug('handleInput queued: session not ready');
        state.inputQueue.push(data);
        return;
      }
      try {
        state.session.write(data);
        debug('session.write OK');
        if (data.includes('\x03')) {
          state.session.interrupt();
          debug('session.interrupt OK');
        }
      } catch (error) {
        debug('session.write FAILED: ' + (error?.stack || error?.message || String(error)));
        console.error('[BusyBox input]', error);
      }
    }
  };
}

function requestDump(state) {
  if (state.closed || !state.writerWorker || state.dumpPending) return;
  state.dumpPending = true;
  state.writerWorker.postMessage({ type: 'dump' });
}

async function createSession(state, scheduleSync) {
  debug('createSession start; crossOriginIsolated=' + String(globalThis.crossOriginIsolated) +
    ', SharedArrayBuffer=' + String(typeof SharedArrayBuffer !== 'undefined') +
    ', Atomics=' + String(typeof Atomics !== 'undefined'));
  let finishProgress;
  let progressReporter;
  const progressDone = new Promise(resolve => {
    finishProgress = resolve;
  });

  const progressPromise = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'BusyBox',
      cancellable: false
    },
    async progress => {
      progressReporter = progress;
      progress.report({ message: 'Inicializálás…' });
      await progressDone;
    }
  );

  const browserFs = vscode.extensions.getExtension('Pandorka132.pythonline-browser-fs');
  debug('browser-fs extension=' + String(!!browserFs));
  if (browserFs) {
    debug('activating browser-fs');
    await browserFs.activate();
    debug('browser-fs activated');
  }

  progressReporter?.report({ message: 'WASI-SH betöltése…' });
  debug('loading wasi-sh spawn.mjs');
  const { spawn } = await loadWasi();
  debug('wasi-sh spawn loaded; spawn=' + typeof spawn);
  progressReporter?.report({ message: 'WASI-SH betöltve' });

  const tree = await collectTree();
  const writerUrl = vscode.Uri.joinPath(extensionUri, 'busybox-writer.mjs').toString(true);
  const shellUrl = vscode.Uri.joinPath(extensionUri, 'busybox-worker.mjs').toString(true);

  progressReporter?.report({ message: 'Fájlrendszer worker indítása…' });
  debug('creating writer worker');
  state.writerWorker = await createWorker(writerUrl);
  debug('writer worker bootstrap ready');
  state.writerWorker.addEventListener('message', async event => {
    const data = event.data;
    if (data?.type === 'ready') {
      debug('writer worker READY; SAB=' + String(!!data.sab) + '; snapshot=' + String(!!data.snapshot));
      progressReporter?.report({ message: 'Fájlrendszer worker kész' });
      state.writerStore = { sab: data.sab, snapshot: data.snapshot };
      if (state.shellWorker) {
        state.shellWorker.postMessage({
          type: 'store',
          sab: data.sab,
          snapshot: data.snapshot
        });
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

  progressReporter?.report({ message: 'Shell worker indítása…' });
  debug('creating shell worker');
  state.shellWorker = await createWorker(shellUrl);
  debug('shell worker bootstrap ready');
  state.shellWorker.addEventListener('error', event => {
    if (!state.closed) state.output.fire('\r\n[BusyBox worker] ' + (event.message || 'worker error') + '\r\n');
  });

  if (state.writerStore) {
    state.shellWorker.postMessage({
      type: 'store',
      sab: state.writerStore.sab,
      snapshot: state.writerStore.snapshot
    });
  }

  state.writerWorker.postMessage({ type: 'init', files: tree.files, directories: tree.directories });

  debug('calling spawn({ tty: true, suspendInput: true })');
  state.session = await spawn({
    worker: state.shellWorker,
    tty: true,
    suspendInput: true,
    wasm: WASM_URL,
    env: {
      HOME: '/workspace',
      PS1: 'workspace@busybox $ '
    },
    onOutput(bytes) {
      const text = new TextDecoder().decode(bytes);
      debug('onOutput: ' + JSON.stringify(text));
      state.output.fire(text.replace(/\n/g, '\r\n'));
    },
    onError(error) {
      debug('onError: ' + (error?.stack || error?.message || String(error)));
      if (!state.closed) state.output.fire('\\r\\n[BusyBox] ' + (error?.message || String(error)) + '\\r\\n');
    },
    onExit(code) {
      debug('onExit: ' + String(code));
      if (!state.closed) state.output.fire('\\r\\n[BusyBox exited: ' + code + ']\\r\\n');
    }
  });

  debug('spawn RESOLVED; session=' + typeof state.session);
  progressReporter?.report({ message: 'Shell session létrejött' });


  finishProgress();
  await progressPromise;

  for (const input of state.inputQueue.splice(0)) {
    state.session.write(input);
  }

  state.session.write("clear() { printf '\\033[2J\\033[H'; }\ncd /workspace\n");
  debug('initial cd /workspace written');
}

async function activate(context) {
  extensionUri = context.extensionUri;
  debugChannel = vscode.window.createOutputChannel('BusyBox Debug');
  context.subscriptions.push(debugChannel);
  debug('extension activate');

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

  context.subscriptions.push(vscode.commands.registerCommand('busybox.showDebug', () => {
    debugChannel?.show(true);
  }));
}

module.exports = { activate };
