import { spawn } from "https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/spawn.mjs";
import { memoryFs, journalWriter } from "https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/fs.mjs";

let session;
let worker;
let writer;
let syncTimer;

function post(type, payload = {}) {
  parent.postMessage({ type, ...payload }, "*");
}

function snapshotStore(store, path = "/workspace", out = []) {
  const st = store.statSync(path);
  const isDir = (st.mode & 0o170000) === 0o040000;
  const entry = { path, mode: st.mode };
  if (isDir) {
    out.push(entry);
    for (const name of store.readdirSync(path)) {
      snapshotStore(store, path + "/" + name, out);
    }
  } else {
    const data = new Uint8Array(st.size);
    if (st.size) store.readSync(path, data, 0, st.size);
    entry.data = data;
    out.push(entry);
  }
  return out;
}

function scheduleSnapshot() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (!writer?.store) return;
    try {
      post("snapshot", { entries: snapshotStore(writer.store) });
    } catch (error) {
      post("error", { message: error?.message || String(error) });
    }
  }, 250);
}

async function start(files = {}, directories = []) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error("BusyBox runtime is not cross-origin isolated.");
  }

  const backing = memoryFs(files);
  try { backing.mkdirSync("/workspace"); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  for (const dir of directories) {
    try { backing.mkdirSync(dir); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  writer = await journalWriter(backing);
  if (writer.ready) await writer.ready;

  worker = new Worker(
    new URL("./extensions/pythonline-busybox/busybox-worker.mjs", location.href),
    { type: "module" }
  );

  worker.addEventListener("error", event => {
    post("error", { message: event.message || "BusyBox worker error" });
  });

  worker.postMessage({
    type: "store",
    sab: writer.sab,
    snapshot: writer.snapshot
  });

  session = await spawn({
    worker,
    tty: true,
    env: {
      HOME: "/workspace",
      PS1: "\\[\\033[32m\\]\\w\\[\\033[0m\\] $ "
    }
  });

  session.onOutput(bytes => {
    post("output", { channel: "stdout", bytes });
  });
  session.onError(error => {
    post("error", { message: error?.message || String(error) });
  });
  session.onExit(code => post("exit", { code }));

  session.write("cd /workspace\n");
  post("ready");
  scheduleSnapshot();
}

window.addEventListener("message", event => {
  const message = event.data || {};
  if (message.type === "start") {
    start(message.files || {}, message.directories || [])
      .catch(error => post("error", { message: error?.stack || String(error) }));
  } else if (message.type === "input") {
    session?.write(message.data || "");
    if ((message.data || "").includes("\x03")) session?.interrupt();
    scheduleSnapshot();
  } else if (message.type === "snapshot") {
    scheduleSnapshot();
  }
});

post("runtime-ready");
