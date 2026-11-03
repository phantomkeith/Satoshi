// Backtester: replays a recorded (or simulated) event tape through the exact same Engine
// used for paper trading. Each candidate runs in its own engine so results are isolated.
import { Engine } from '../core/engine.js';
import { fitness } from '../core/strategy.js';

export function statsFromTrades(trades) {
  const st = { n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, cum: 0, peak: 0, maxDD: 0 };
  for (const t of trades) {
    st.n++; st.pnl += t.pnlSol; st.cum += t.pnlSol;
    if (t.pnlSol > 0) { st.wins++; st.grossWin += t.pnlSol; } else st.grossLoss -= t.pnlSol;
    if (st.cum > st.peak) st.peak = st.cum;
    st.maxDD = Math.max(st.maxDD, st.peak - st.cum);
  }
  st.winRate = st.n ? st.wins / st.n : 0;
  st.pf = st.grossLoss > 0 ? st.grossWin / st.grossLoss : st.grossWin > 0 ? 99 : 0;
  return st;
}

export const STRESS_EXEC = { latencyMs: 1200, failRate: 0.2, priorityFeeSol: 0.001, jitoTipSol: 0.001 };

/**
 * Run one strategy over the tape. Returns in-sample / out-of-sample split stats.
 * @param opts {exec, startingSol, splitAt (0..1), creatorRugs (object map)}
 */
export function backtestStrategy(events, strategy, opts = {}) {
  const rugs = opts.creatorRugs || {};
  const s = { ...strategy, active: true, params: { ...strategy.params } };
  const eng = new Engine({ strategies: [s], startingSol: opts.startingSol ?? 10, exec: opts.exec, seed: opts.seed ?? 11, fixedSizing: opts.fixedSizing ?? true,
    creatorRugs: (c) => rugs[c] || 0 });
  for (const e of events) eng.handle(e);
  eng.liquidateAll('backtest_end');
  const trades = eng.closed;
  const t0 = events.length ? events[0].ts : 0;
  const t1 = events.length ? events[events.length - 1].ts : 0;
  const cut = t0 + (t1 - t0) * (opts.splitAt ?? 0.65);
  const all = statsFromTrades(trades);
  const is = statsFromTrades(trades.filter((t) => t.openTs < cut));
  const oos = statsFromTrades(trades.filter((t) => t.openTs >= cut));
  const causes = {};
  for (const t of trades) causes[t.exitReason] = (causes[t.exitReason] || 0) + 1;
  return { id: strategy.id, all, is, oos, fitAll: fitness(all), fitIS: fitness(is, { minTrades: 3 }), fitOOS: fitness(oos, { minTrades: 2 }),
    exits: causes, equityEnd: eng.cash, trades: opts.keepTrades ? trades : undefined };
}

export function runJobs(events, jobs) {
  return jobs.map((j) => {
    try { return { tag: j.tag, ...backtestStrategy(events, j.strategy, j.opts || {}) }; }
    catch (err) { return { tag: j.tag, id: j.strategy.id, error: String(err) }; }
  });
}
