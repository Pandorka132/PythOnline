self.addEventListener("message", async event => {
  if (event.data?.type !== "load") return;
  try {
    const module = await import(event.data.url);
    module.init(event.data.inputSab);
  } catch (error) {
    self.postMessage({type:"error", id:0, error:error?.stack || String(error)});
  }
});