import { parentPort } from 'node:worker_threads';
import { runJobs } from './backtest.js';

parentPort.on('message', ({ id, events, jobs }) => {
  const t0 = Date.now();
  const results = runJobs(events, jobs);
  parentPort.postMessage({ id, results, ms: Date.now() - t0 });
});
