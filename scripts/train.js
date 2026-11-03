#!/usr/bin/env node
// Fast-forward training: generates hours of synthetic Pump.fun market in seconds and runs the
// full GrokDesk loop (paper trading + autopsies + rewrites + evolution) in market time.
// Usage: node scripts/train.js [hours=3] [seed=42] [--persist]
import path from 'node:path';
import { config } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { Memory } from '../server/learn/memory.js';
import { BacktestService } from '../server/learn/backtestService.js';
import { generateTape } from '../server/sim/market.js';
import { LLM } from '../server/agents/llm.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const hours = +(args[0] || 3);
const seed = +(args[1] || 42);
const persist = process.argv.includes('--persist');
const quiet = process.argv.includes('--quiet');

const memory = new Memory(path.join(config.dataDir, persist ? '' : 'train-tmp'), { persist });
const cfg = { ...config, recordTape: false, evolveEverySec: 900, evolveWindowMin: 60, minTapeMin: 20 };
const desk = new Desk({ config: cfg, memory, llm: new LLM(), backtests: new BacktestService({ mode: 'inline' }), clock: 'event', seed });
const show = new Set(['promote', 'loss', 'alert']);
desk.on('message', (m) => {
  if (quiet) return;
  if (show.has(m.level) || m.agent === 'strategist' || m.agent === 'researcher')
    console.log(`[${new Date(m.ts).toISOString().slice(11, 19)}] ${m.agent.toUpperCase().padEnd(10)} ${m.text}`);
});

console.log(`Generating ${hours}h of synthetic pump.fun tape (seed ${seed})…`);
const tape = generateTape({ seed, durationSec: hours * 3600, launchesPerMin: 12 });
console.log(`${tape.length.toLocaleString()} events, ${tape.filter((e) => e.type === 'create').length} launches\n`);

const hourly = [];
let nextMark = tape[0].ts + 3_600_000;
const t0 = Date.now();
for (const e of tape) {
  const { _arch, ...ev } = e;
  const p = desk.ingest(ev);
  if (p) await p;
  if (ev.ts >= nextMark) { nextMark += 3_600_000; hourly.push(snapshotLine(desk)); }
}
desk.engine.liquidateAll('end');
desk.runAutopsies(true);
hourly.push(snapshotLine(desk));

function snapshotLine(d) {
  const p = d.portfolio();
  const recent = d.engine.closed.slice(-60);
  const wr = recent.length ? recent.filter((t) => t.pnlSol > 0).length / recent.length : 0;
  return { hour: hourly.length + 1, equity: p.equity, trades: p.trades, winRate: p.winRate, recentWR: wr, maxDD: p.maxDD };
}

console.log('\n=== Hourly progress ===');
for (const h of hourly) console.log(`h${h.hour}: equity ${h.equity.toFixed(3)} SOL · trades ${h.trades} · win ${(h.winRate * 100).toFixed(0)}% (last 60: ${(h.recentWR * 100).toFixed(0)}%) · maxDD ${h.maxDD.toFixed(1)}%`);
console.log('\n=== Strategy leaderboard ===');
for (const s of desk.strategies()) console.log(`${s.active ? '●' : '○'} ${s.name.padEnd(22)} g${String(s.gen).padEnd(3)} ${s.origin.padEnd(12)} live n=${String(s.live.n).padEnd(4)} pnl ${s.live.pnl.toFixed(3).padStart(7)} SOL  PF ${s.live.pf.toFixed(2)}`);
console.log('\n=== Loss causes learned ===');
console.log(memory.data.causeCounts);
console.log(`\nLearning: ${JSON.stringify(desk.learn)}`);
console.log(`Blacklisted creators: ${Object.keys(memory.data.creatorRugs).length}`);
console.log(`Ran in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (persist) desk.persist();
