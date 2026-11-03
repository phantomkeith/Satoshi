#!/usr/bin/env node
// Backtest the seed strategies (or saved ones) on a tape file or a fresh synthetic tape, normal + stress.
// Usage: node scripts/backtest.js [tape.jsonl] [--strategies data/live/memory.json]
import fs from 'node:fs';
import { generateTape } from '../server/sim/market.js';
import { backtestStrategy, STRESS_EXEC } from '../server/learn/backtest.js';
import { SEED_STRATEGIES, makeStrategy } from '../server/core/strategy.js';

const file = process.argv.slice(2).find((a) => a.endsWith('.jsonl'));
const memIdx = process.argv.indexOf('--strategies');
const tape = file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : generateTape({ seed: 7, durationSec: 7200 });
const strategies = memIdx > 0 ? JSON.parse(fs.readFileSync(process.argv[memIdx + 1], 'utf8')).strategies.filter((s) => s.active) : SEED_STRATEGIES.map(makeStrategy);
console.log(`${tape.length.toLocaleString()} events from ${file || 'synthetic tape'}\n`);
console.log('strategy'.padEnd(24), 'n'.padStart(4), 'win%'.padStart(5), 'pnl SOL'.padStart(9), 'maxDD'.padStart(7), 'PF'.padStart(6), '| stress pnl'.padStart(12));
for (const s of strategies) {
  const r = backtestStrategy(tape, s), st = backtestStrategy(tape, s, { exec: STRESS_EXEC });
  console.log(`${s.name} g${s.gen}`.padEnd(24), String(r.all.n).padStart(4), (r.all.winRate * 100).toFixed(0).padStart(5), r.all.pnl.toFixed(3).padStart(9),
    r.all.maxDD.toFixed(3).padStart(7), Math.min(r.all.pf, 99).toFixed(2).padStart(6), '|', st.all.pnl.toFixed(3).padStart(10));
}
