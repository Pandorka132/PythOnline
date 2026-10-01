self.addEventListener('message', async (event) => {
  if (event.data?.type !== 'load') return;

  try {
    await import(event.data.url);
    self.postMessage({ type: 'worker-bootstrap-ready' });
  } catch (error) {
    self.postMessage({
      type: 'worker-bootstrap-error',
      message: error?.stack || error?.message || String(error)
    });
  }
});
