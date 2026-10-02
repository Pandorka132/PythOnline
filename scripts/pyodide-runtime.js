const WORKER_URL = new URL("./pyodide-runtime-worker.js", location.href);
let worker;
let inputState;
let inputBytes;

function fail(message, id) {
  parent.postMessage({ type: "runtime-fatal", message, ...(id === undefined ? {} : { id }) }, "*");
}

if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
  fail("A Python runtime oldala nem cross-origin isolated (crossOriginIsolated=" + globalThis.crossOriginIsolated + ").");
} else {
  const inputSab = new SharedArrayBuffer(8 + 65536);
  inputState = new Int32Array(inputSab, 0, 2);
  inputBytes = new Uint8Array(inputSab, 8);
  worker = new Worker(WORKER_URL, { type: "module" });

  worker.addEventListener("message", event => {
    parent.postMessage(event.data, "*");
  });
  worker.addEventListener("error", event => {
    fail("Pyodide worker hiba: " + (event.message || "ismeretlen hiba"));
  });

  worker.postMessage({ type: "init", sab: inputSab });
}

window.addEventListener("message", event => {
  const message = event.data || {};
  if (message.type === "request") {
    worker?.postMessage(message);
  } else if (message.type === "stdin") {
    if (!inputState || !inputBytes) return;
    const bytes = new TextEncoder().encode(message.text || "");
    const length = Math.min(bytes.length, inputBytes.length);
    inputBytes.fill(0);
    inputBytes.set(bytes.subarray(0, length));
    Atomics.store(inputState, 1, length);
    Atomics.store(inputState, 0, 1);
    Atomics.notify(inputState, 0);
  }
});
