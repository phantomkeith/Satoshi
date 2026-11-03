// Runs backtests either inline (deterministic training) or in a worker thread (live server,
// so the feed / UI never stall while the Strategist is thinking).
import { Worker } from 'node:worker_threads';
import { runJobs } from './backtest.js';

export class BacktestService {
  constructor({ mode = 'worker' } = {}) {
    this.mode = mode;
    this.seq = 0;
    this.waiters = new Map();
    if (mode === 'worker') {
      this.worker = new Worker(new URL('./worker.js', import.meta.url));
      this.worker.on('message', ({ id, results, ms }) => { const w = this.waiters.get(id); this.waiters.delete(id); if (!this.waiters.size) this.worker.unref(); w?.({ results, ms }); });
      this.worker.on('error', (e) => { for (const w of this.waiters.values()) w({ results: [], ms: 0, error: String(e) }); this.waiters.clear(); });
      this.worker.unref();
    }
  }
  run(events, jobs) {
    if (this.mode !== 'worker') {
      const t0 = Date.now();
      return Promise.resolve({ results: runJobs(events, jobs), ms: Date.now() - t0 });
    }
    const id = ++this.seq;
    this.worker.ref(); // keep the process alive while a job is in flight
    return new Promise((resolve) => { this.waiters.set(id, resolve); this.worker.postMessage({ id, events, jobs }); });
  }
  close() { this.worker?.terminate(); }
}
