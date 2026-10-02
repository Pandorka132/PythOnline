import { memoryFs, journalWriter } from 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/fs.mjs';

let writer;

async function walk(store, path, files, directories) {
  const stat = store.statSync(path);
  const isDir = (stat.mode & 0o170000) === 0o040000;
  if (isDir) {
    if (path !== '/workspace') directories.push(path);
    for (const name of store.readdirSync(path)) {
      await walk(store, path === '/' ? '/' + name : path + '/' + name, files, directories);
    }
  } else {
    const data = new Uint8Array(stat.size);
    if (stat.size) store.readSync(path, data, 0, stat.size);
    files.push({ path, data: data.buffer });
  }
}

self.addEventListener('message', async (event) => {
  const data = event.data;
  try {
    if (data?.type === 'init') {
      const backing = memoryFs(data.files || {});
      try { backing.mkdirSync('/workspace'); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
      for (const dir of (data.directories || []).sort((a,b) => a.length - b.length)) {
        try { backing.mkdirSync(dir); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
      }

      writer = await journalWriter(backing);
      if (writer.ready) await writer.ready;
      if (!writer.store) throw new Error('wasi-sh journal writer did not expose its store');

      self.postMessage({
        type: 'ready',
        sab: writer.sab,
        snapshot: writer.snapshot
      });
      return;
    }

    if (data?.type === 'dump') {
      if (!writer?.store) throw new Error('BusyBox writer is not ready');
      const files = [];
      const directories = [];
      await walk(writer.store, '/workspace', files, directories);
      self.postMessage(
        { type: 'dump', files, directories },
        files.map(file => file.data)
      );
      return;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error?.stack || error?.message || String(error)
    });
  }
});
