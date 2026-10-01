import { serve } from 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/worker.mjs';
import { journalFs } from 'https://cdn.jsdelivr.net/npm/wasi-sh@0.11.0/src/fs.mjs';

let handOver;
const handed = new Promise((resolve) => {
  handOver = resolve;
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'store') return;

  handOver(journalFs(event.data.sab, event.data.snapshot));
});

serve({
  fs: () => handed
});
