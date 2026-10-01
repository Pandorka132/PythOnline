const vscode = require('vscode');

const DB_NAME = 'pythonline-filesystem';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const ROOT = '/workspace';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
  });
}

function normalizePath(value) {
  const raw = String(value || '/').replace(/\\/g, '/');
  const parts = raw.split('/');
  const result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length > 0) result.pop();
      continue;
    }
    result.push(part);
  }
  return '/' + result.join('/');
}

function parentPath(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function baseName(path) {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isChildOf(path, parent) {
  return path.startsWith(parent === '/' ? '/' : parent + '/');
}

function fileType(entry) {
  return entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File;
}

function statOf(entry) {
  return {
    type: fileType(entry),
    ctime: entry.ctime,
    mtime: entry.mtime,
    size: entry.size
  };
}

class BrowserFileSystemProvider {
  constructor(db) {
    this.db = db;
    this._onDidChangeFile = new vscode.EventEmitter();
    this.onDidChangeFile = this._onDidChangeFile.event;
  }

  async ensureRoot() {
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const root = await request(store.get(ROOT));
    if (!root) {
      const now = Date.now();
      store.put({
        path: ROOT,
        type: 'directory',
        ctime: now,
        mtime: now,
        size: 0
      });
    } else if (root.type !== 'directory') {
      throw new Error('PythOnline filesystem root is not a directory');
    }
    await transactionDone(tx);
  }

  async get(path) {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    return request(tx.objectStore(STORE_NAME).get(normalizePath(path)));
  }

  uriPath(uri) {
    const path = normalizePath(uri.path);
    if (path !== ROOT && !isChildOf(path, ROOT)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return path;
  }

  async stat(uri) {
    const path = this.uriPath(uri);
    const entry = await this.get(path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return statOf(entry);
  }

  async readDirectory(uri) {
    const path = this.uriPath(uri);
    const directory = await this.get(path);
    if (!directory) throw vscode.FileSystemError.FileNotFound(uri);
    if (directory.type !== 'directory') throw vscode.FileSystemError.FileNotADirectory(uri);

    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const entries = await request(tx.objectStore(STORE_NAME).getAll());
    const prefix = path === '/' ? '/' : path + '/';
    const result = [];
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix) || entry.path === path) continue;
      const rest = entry.path.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      result.push([rest, fileType(entry)]);
    }
    result.sort((a, b) => a[0].localeCompare(b[0]));
    return result;
  }

  async readFile(uri) {
    const path = this.uriPath(uri);
    const entry = await this.get(path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (entry.type !== 'file') throw vscode.FileSystemError.FileIsADirectory(uri);
    return new Uint8Array(entry.data || new ArrayBuffer(0));
  }

  async createDirectory(uri) {
    const path = this.uriPath(uri);
    if (path === ROOT) return;

    const existing = await this.get(path);
    if (existing && existing.type === 'file') {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (existing) return;

    const missing = [];
    let current = path;
    while (current !== ROOT) {
      const entry = await this.get(current);
      if (entry) {
        if (entry.type !== 'directory') throw vscode.FileSystemError.FileNotADirectory(uri);
        break;
      }
      missing.push(current);
      current = parentPath(current);
      if (!isChildOf(current, ROOT) && current !== ROOT) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }

    const now = Date.now();
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const dir of missing.reverse()) {
      store.put({ path: dir, type: 'directory', ctime: now, mtime: now, size: 0 });
    }
    await transactionDone(tx);

    this._onDidChangeFile.fire(
      missing.reverse().map(path => ({ type: vscode.FileChangeType.Created, uri: vscode.Uri.parse('pythonline:' + path) }))
    );
  }

  async writeFile(uri, content, options) {
    const path = this.uriPath(uri);
    if (path === ROOT) throw vscode.FileSystemError.FileIsADirectory(uri);

    const parent = await this.get(parentPath(path));
    if (!parent) throw vscode.FileSystemError.FileNotFound(uri);
    if (parent.type !== 'directory') throw vscode.FileSystemError.FileNotADirectory(uri);

    const existing = await this.get(path);
    if (existing && existing.type === 'directory') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);

    const now = Math.max(Date.now(), existing ? existing.mtime + 1 : 0);
    const data = content.slice().buffer;
    const entry = {
      path,
      type: 'file',
      ctime: existing ? existing.ctime : now,
      mtime: now,
      size: content.byteLength,
      data
    };

    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    await transactionDone(tx);

    this._onDidChangeFile.fire([{
      type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
      uri
    }]);
  }

  async delete(uri, options) {
    const path = this.uriPath(uri);
    if (path === ROOT) throw vscode.FileSystemError.NoPermissions(uri);

    const entry = await this.get(path);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (entry.type === 'directory' && !options.recursive) {
      const children = await this.readDirectory(uri);
      if (children.length) throw vscode.FileSystemError.FileNotFound(uri);
    }

    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const all = await request(store.getAll());
    const targets = all
      .filter(candidate => candidate.path === path || isChildOf(candidate.path, path))
      .map(candidate => candidate.path);
    for (const target of targets) store.delete(target);
    await transactionDone(tx);

    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri, newUri, options) {
    const oldPath = this.uriPath(oldUri);
    const newPath = this.uriPath(newUri);
    if (oldPath === ROOT || newPath === ROOT) {
      throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    const source = await this.get(oldPath);
    if (!source) throw vscode.FileSystemError.FileNotFound(oldUri);

    const newParent = await this.get(parentPath(newPath));
    if (!newParent) throw vscode.FileSystemError.FileNotFound(newUri);
    if (newParent.type !== 'directory') throw vscode.FileSystemError.FileNotADirectory(newUri);

    const destination = await this.get(newPath);
    if (destination && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);

    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const all = await request(store.getAll());
    const moved = all.filter(entry => entry.path === oldPath || isChildOf(entry.path, oldPath));

    if (destination) {
      for (const entry of all) {
        if (entry.path === newPath || isChildOf(entry.path, newPath)) {
          store.delete(entry.path);
        }
      }
    }

    for (const entry of moved) {
      store.delete(entry.path);
      const suffix = entry.path.slice(oldPath.length);
      store.put({ ...entry, path: newPath + suffix, mtime: Math.max(entry.mtime, Date.now()) });
    }
    await transactionDone(tx);

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  async copy(sourceUri, destinationUri, options) {
    const sourcePath = this.uriPath(sourceUri);
    const destinationPath = this.uriPath(destinationUri);
    const source = await this.get(sourcePath);
    if (!source) throw vscode.FileSystemError.FileNotFound(sourceUri);

    const parent = await this.get(parentPath(destinationPath));
    if (!parent) throw vscode.FileSystemError.FileNotFound(destinationUri);
    if (parent.type !== 'directory') throw vscode.FileSystemError.FileNotADirectory(destinationUri);

    const destination = await this.get(destinationPath);
    if (destination && !options.overwrite) throw vscode.FileSystemError.FileExists(destinationUri);

    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const all = await request(store.getAll());

    if (destination) {
      for (const entry of all) {
        if (entry.path === destinationPath || isChildOf(entry.path, destinationPath)) {
          store.delete(entry.path);
        }
      }
    }

    const sourceEntries = all.filter(entry => entry.path === sourcePath || isChildOf(entry.path, sourcePath));
    for (const entry of sourceEntries) {
      const suffix = entry.path.slice(sourcePath.length);
      store.put({ ...entry, path: destinationPath + suffix, ctime: Date.now(), mtime: Date.now() });
    }
    await transactionDone(tx);

    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri: destinationUri }]);
  }

  watch() {
    return new vscode.Disposable(() => {});
  }
}

async function clearDatabase(db) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await transactionDone(tx);
}

async function activate(context) {
  const db = await openDatabase();
  const provider = new BrowserFileSystemProvider(db);
  await provider.ensureRoot();

  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
    } catch {
      // Persistence is best-effort; IndexedDB still survives normal reloads.
    }
  }

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('pythonline', provider, {
      isCaseSensitive: true
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pythonline.clearBrowserFilesystem', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Törlöd a PythOnline böngészőben mentett összes fájlját?',
        { modal: true },
        'Törlés'
      );
      if (choice !== 'Törlés') return;

      await clearDatabase(db);
      await provider.ensureRoot();
      vscode.window.showInformationMessage('A PythOnline böngésző-fájlrendszer törölve.');
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    })
  );
}

module.exports = { activate };
