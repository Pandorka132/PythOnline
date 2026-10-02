let loaded = false;
let loading = false;
const queuedMessages = [];

async function handleMessage(event) {
  if (loaded) {
    self.onmessage?.(event);
    return;
  }

  if (event.data?.type !== "load") {
    queuedMessages.push(event);
    return;
  }

  if (loading) return;
  loading = true;

  try {
    if (event.data.inputBuffer) {
      self.__pyodideInputBuffer = event.data.inputBuffer;
    }
    await import(event.data.url);
    loaded = true;

    self.removeEventListener("message", handleMessage);

    for (const queued of queuedMessages.splice(0)) {
      self.onmessage?.(queued);
    }
  } catch (error) {
    self.postMessage({
      type: "workerBootstrapError",
      error: error?.stack || String(error)
    });
  }
}

self.addEventListener("message", handleMessage);
