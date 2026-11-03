#!/usr/bin/env node
// Honest strategy evaluation:
//  1) TRAIN: run the full GrokDesk learning loop (paper trades -> autopsies -> rewrites -> evolution)
//     on a long synthetic session.
//  2) TEST: take the seed strategies + everything the desk learned and backtest them on market
//     sessions they have NEVER seen (different seeds), at normal and stress execution, with fixed
//     2%-of-start sizing (no compounding), and break results down by coin archetype.
// Usage: node scripts/evaluate.js [trainHours=6] [holdoutSessions=5]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { Memory } from '../server/learn/memory.js';
import { BacktestService } from '../server/learn/backtestService.js';
import { backtestStrategy, statsFromTrades, STRESS_EXEC } from '../server/learn/backtest.js';
import { generateTape } from '../server/sim/market.js';
import { SEED_STRATEGIES, makeStrategy } from '../server/core/strategy.js';
import { LLM } from '../server/agents/llm.js';

const trainHours = +(process.argv[2] || 6);
const nHold = +(process.argv[3] || 5);
const t0 = Date.now();
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 1) train
log(`TRAIN: ${trainHours}h synthetic session, full learning loop…`);
const memory = new Memory('/tmp/unused', { persist: false });
const cfg = { ...config, recordTape: false, fixedSizing: true, evolveEverySec: 900, evolveWindowMin: 60, minTapeMin: 20 };
const desk = new Desk({ config: cfg, memory, llm: new LLM(), backtests: new BacktestService({ mode: 'inline' }), seed: 100 });
const train = generateTape({ seed: 100, durationSec: trainHours * 3600 });
const hourly = [];
let mark = train[0].ts + 3_600_000;
for (const e of train) {
  const { _arch, ...ev } = e;
  const p = desk.ingest(ev); if (p) await p;
  if (ev.ts >= mark) {
    mark += 3_600_000;
    const c = desk.engine.closed, hr = c.filter((t) => t.closeTs > ev.ts - 3_600_000);
    hourly.push({ h: hourly.length + 1, equity: desk.engine.equity(), n: hr.length, pnl: hr.reduce((a, t) => a + t.pnlSol, 0), wr: hr.length ? hr.filter((t) => t.pnlSol > 0).length / hr.length : 0 });
    log(`  hour ${hourly.length}: equity ${desk.engine.equity().toFixed(2)} SOL · ${hr.length} trades · hour pnl ${hourly.at(-1).pnl.toFixed(2)} · win ${(hourly.at(-1).wr * 100).toFixed(0)}% · promotions so far ${desk.learn.promotions}`);
  }
}
desk.engine.liquidateAll('end'); desk.runAutopsies(true);
const learned = desk.engine.activeStrategies().map((s) => ({ ...s, label: `${s.name} g${s.gen} (learned)` }));

// ---------------------------------------------------------------- 2) test on unseen sessions
const seeds = SEED_STRATEGIES.map((s) => ({ ...makeStrategy(s), label: `${s.name} g1 (seed)` }));
const contenders = [...seeds, ...learned];
log(`\nTEST: ${contenders.length} strategies × ${nHold} unseen 1h sessions × {normal, stress}…`);
const tapes = Array.from({ length: nHold }, (_, i) => generateTape({ seed: 900 + i, durationSec: 3600 }));
const archOf = new Map();
for (const tp of tapes) for (const e of tp) if (e.type === 'create') archOf.set(e.mint, e._arch);
const clean = tapes.map((tp) => tp.map(({ _arch, ...e }) => e));

const rows = [];
for (const s of contenders) {
  const all = [], stress = [], perSession = [];
  for (const tp of clean) {
    const r = backtestStrategy(tp, s, { keepTrades: true });
    const st = backtestStrategy(tp, s, { exec: STRESS_EXEC, keepTrades: true });
    all.push(...r.trades); stress.push(...st.trades); perSession.push(r.all.pnl);
  }
  const N = statsFromTrades(all), S = statsFromTrades(stress);
  const by = {};
  for (const t of all) { const a = archOf.get(t.mint) || '?'; by[a] ??= { n: 0, pnl: 0 }; by[a].n++; by[a].pnl += t.pnlSol; }
  const bad = ['rug_dev', 'bundle_rug', 'pump_dump', 'dead', 'fader'].reduce((a, k) => a + (by[k]?.n || 0), 0);
  rows.push({ s, N, S, by, perSession, badPct: N.n ? bad / N.n : 0, avgPct: all.length ? all.reduce((a, t) => a + t.pnlPct, 0) / all.length : 0,
    profitableSessions: perSession.filter((x) => x > 0).length });
}
rows.sort((a, b) => (b.S.pnl > 0) - (a.S.pnl > 0) || b.N.pnl - a.N.pnl);

const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const lines = [];
lines.push(`| # | Strategy | Trades | Win | PnL (SOL) | PF | Max DD | Avg trade | Green sessions | Stress PnL | Bad-coin entries |`);
lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.s.label} | ${r.N.n} | ${(r.N.winRate * 100).toFixed(0)}% | ${f(r.N.pnl)} | ${Math.min(r.N.pf, 99).toFixed(2)} | ${r.N.maxDD.toFixed(2)} | ${f(r.avgPct, 1)}% | ${r.profitableSessions}/${nHold} | ${f(r.S.pnl)} | ${(r.badPct * 100).toFixed(0)}% |`));
log('\n' + lines.join('\n'));

const best = rows[0];
const archLines = Object.entries(best.by).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `| ${k} | ${v.n} | ${f(v.pnl)} |`);
log(`\nBEST: ${best.s.label}\n` + archLines.join('\n'));

// ---------------------------------------------------------------- report
const P = Object.fromEntries(Object.entries(best.s.params).map(([k, v]) => [k, Math.round(v * 10) / 10]));
const report = `# GrokDesk strategy evaluation

Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`node scripts/evaluate.js ${trainHours} ${nHold}\` (${((Date.now() - t0) / 1000).toFixed(0)}s).

> **Synthetic market only.** These numbers come from the built-in Pump.fun simulator, not real on-chain data. They show
> whether the learning loop picks better rules than the starting ones; they do **not** predict live profit.
> Sizing is fixed at ≤2% of the 10 SOL start (0.2 SOL per trade max), no compounding.

## 1. Training (${trainHours}h session, full learning loop)

| Hour | Equity (SOL) | Trades | Hour PnL | Win rate |
|---|---|---|---|---|
${hourly.map((h) => `| ${h.h} | ${h.equity.toFixed(2)} | ${h.n} | ${f(h.pnl)} | ${(h.wr * 100).toFixed(0)}% |`).join('\n')}

Learning: ${desk.learn.patches} critic patches, ${desk.learn.cycles} evolution cycles, ${desk.learn.promotions} promotions, ${desk.learn.rejections} rejected changes, ${desk.learn.retired} retired, ${Object.keys(memory.data.creatorRugs).length} rug creators blacklisted.

Loss causes diagnosed by the Critic:

| Cause | Count |
|---|---|
${Object.entries(memory.data.causeCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## 2. Out-of-sample test (${nHold} unseen 1h sessions, normal + stress execution)

Stress = 1.2s latency, 20% failed transactions, 2× fees. "Bad-coin entries" = share of buys into coins that were
actually rugs, bundles, pump & dumps, fakes ("faders") or dead.

${lines.join('\n')}

## 3. Best sniping strategy: ${best.s.label}

${best.s.thesis || ''}

What it bought, by true coin type (unseen sessions):

| Coin type | Trades | PnL (SOL) |
|---|---|---|
${archLines.join('\n')}

Rules:

| | |
|---|---|
| Entry timing | wait ${P.entryDelaySec}s after launch, never after ${P.maxEntryAgeSec}s |
| Market cap window | ${P.minMcapSol}–${P.maxMcapSol} SOL |
| Proof of life (anti-dead-coin) | ≥ ${P.minUniqueBuyers} unique buyers, ≥ ${P.minVel10} trades / 10s, last trade ≤ ${P.maxTradeGapSec}s ago, buy/sell SOL ≥ ${P.minBsRatio}, net inflow ≥ ${P.minNet30} SOL / 30s |
| Safety | dev bag ≤ ${P.maxDevHoldPct}%, dev sold ≤ ${(P.maxDevSoldPct * 100).toFixed(0)}%, bundle ≤ ${P.maxBundlePct}%, top-10 ≤ ${P.maxTop10Pct}%, socials ${P.requireSocials ? 'required' : 'optional'}, known ruggers ≤ ${P.maxCreatorRugs} |
| Don't chase | run-up ≤ ${P.maxRunupPct}%, ≤ ${P.maxFromPeakPct}% below local peak |
| Whale logic | whale = single buy ≥ ${P.whaleBuySol} SOL; need ≥ ${P.minWhaleSol30} SOL of whale buys in 30s; while whales buy, trailing stop +${P.whaleTrailBonusPct}% and hold up to 2× longer (${P.whaleHoldSec}s window) |
| Size | ${P.sizePct}% of equity (hard cap 2%) |
| Exits | stop −${P.stopLossPct}%, take ${P.tp1SellPct}% off at +${P.takeProfitPct}%, trailing ${P.trailingStopPct}%, exit if no trades for ${P.deadExitSec}s, sell-pressure ratio ${P.sellPressureExit}, dev sells ≥ ${(P.devSellExitPct * 100).toFixed(0)}% → exit now, max hold ${P.maxHoldSec}s |

Full parameter set: [\`docs/best-strategy.json\`](best-strategy.json).
`;
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/evaluation.md', report);
fs.writeFileSync('docs/best-strategy.json', JSON.stringify({ name: best.s.name, gen: best.s.gen, origin: best.s.origin, thesis: best.s.thesis, params: best.s.params,
  holdout: { trades: best.N.n, winRate: best.N.winRate, pnlSol: best.N.pnl, stressPnlSol: best.S.pnl, maxDD: best.N.maxDD } }, null, 2));
// Hand learned strategies to the live desk as its starting lineup (sim memory stays separate from live).
const out = path.join(config.dataDir, 'learned-strategies.json');
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows.filter((r) => r.S.pnl > 0).slice(0, 6).map((r) => r.s), null, 2));
log(`\nWrote docs/evaluation.md, docs/best-strategy.json, ${out} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
