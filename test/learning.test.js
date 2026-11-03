import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autopsy, applyAdjustments, consolidate } from '../server/agents/critic.js';
import { Strategist } from '../server/agents/strategist.js';
import { makeStrategy, SEED_STRATEGIES, PARAM_SPACE, normalizeParams, BASE_PARAMS } from '../server/core/strategy.js';
import { BacktestService } from '../server/learn/backtestService.js';
import { backtestStrategy } from '../server/learn/backtest.js';
import { Memory } from '../server/learn/memory.js';
import { Desk } from '../server/desk.js';
import { LLM } from '../server/agents/llm.js';
import { generateTape } from '../server/sim/market.js';
import { Rng } from '../server/util/rng.js';
import { config } from '../server/config.js';

const params = normalizeParams(BASE_PARAMS);
const baseTrade = (over = {}) => ({
  id: 'p1', strategyId: 's', strategyName: 'Test', gen: 1, mint: 'M', symbol: 'RUG', creator: 'DEV', openTs: 0, closeTs: 30_000, holdSec: 30,
  costSol: 0.2, proceedsSol: 0.1, pnlSol: -0.1, pnlPct: -50, exitReason: 'rug_guard', params, slipPct: 1, peakPnlPct: 4, maxAdversePct: -50,
  entryPrice: 1, entryFeatures: { devHoldPct: 9, bundlePct: 0, bundleWallets: 0, vel10: 8, uniqueBuyers: 20, buys: 30, runupPct: 50, fromPeakPct: 2, top10Pct: 25, net30: 2, whaleSol30: 0 },
  ...over,
});

test('critic diagnoses a dev rug and tightens the dev-bag filter', () => {
  const a = autopsy(baseTrade(), { devSoldPctAfter: 1 });
  assert.equal(a.cause, 'dev_rug');
  const p2 = applyAdjustments(params, a.adjust);
  assert.ok(p2.maxDevHoldPct < params.maxDevHoldPct);
  assert.ok(p2.entryDelaySec > params.entryDelaySec);
});

test('critic spots a stop that was too tight and widens it', () => {
  const t = baseTrade({ exitReason: 'stop_loss', pnlPct: -21, entryFeatures: { ...baseTrade().entryFeatures, devHoldPct: 1 } });
  const a = autopsy(t, { maxPriceAfter: 1.6, tradesAfter: 40, devSoldPctAfter: 0 });
  assert.equal(a.cause, 'stop_too_tight');
  assert.ok(applyAdjustments(params, a.adjust).stopLossPct > params.stopLossPct);
});

test('critic flags dead coins and demands more proof of life', () => {
  const t = baseTrade({ exitReason: 'dead_coin', entryFeatures: { ...baseTrade().entryFeatures, devHoldPct: 1, vel10: 3, uniqueBuyers: 6 } });
  const a = autopsy(t, { tradesAfter: 0 });
  assert.equal(a.cause, 'dead_coin');
  const p2 = applyAdjustments(params, a.adjust);
  assert.ok(p2.minVel10 > params.minVel10 && p2.minUniqueBuyers > params.minUniqueBuyers);
});

test('consolidate merges repeated causes', () => {
  const a = autopsy(baseTrade(), { devSoldPctAfter: 1 });
  const plan = consolidate([a, a, a]);
  assert.deepEqual(plan.causes, ['dev_rug×3']);
  assert.ok(plan.adjust.length >= 1);
});

test('strategist mutations stay inside the parameter space', () => {
  const st = new Strategist({ rng: new Rng(1), backtests: null });
  let s = makeStrategy(SEED_STRATEGIES[0]);
  for (let i = 0; i < 200; i++) {
    s = st.mutate(s, 0.5, 0.6);
    for (const [k, sp] of Object.entries(PARAM_SPACE)) assert.ok(s.params[k] >= sp.min && s.params[k] <= sp.max, `${k}=${s.params[k]}`);
  }
  assert.equal(s.gen, 201);
});

test('backtest splits in-sample / out-of-sample and is deterministic', () => {
  const tape = generateTape({ seed: 77, durationSec: 1200 });
  const s = makeStrategy(SEED_STRATEGIES[1]);
  const a = backtestStrategy(tape, s), b = backtestStrategy(tape, s);
  assert.equal(a.all.n, a.is.n + a.oos.n);
  assert.deepEqual(a.all, b.all);
});

test('worker-thread backtests match inline backtests', async () => {
  const tape = generateTape({ seed: 5, durationSec: 600 });
  const jobs = [{ tag: 'x', strategy: makeStrategy(SEED_STRATEGIES[2]) }];
  const w = new BacktestService({ mode: 'worker' });
  const [rw] = (await w.run(tape, jobs)).results;
  const [ri] = (await new BacktestService({ mode: 'inline' }).run(tape, jobs)).results;
  w.close();
  assert.deepEqual(rw.all, ri.all);
});

test('desk learns from losses end-to-end: autopsies, lessons, validated rewrites', async () => {
  const memory = new Memory('/tmp/unused', { persist: false });
  const cfg = { ...config, recordTape: false, evolveEverySec: 600, evolveWindowMin: 30, minTapeMin: 10, patchAfterLosses: 3, patchCooldownSec: 120 };
  const desk = new Desk({ config: cfg, memory, llm: new LLM(), backtests: new BacktestService({ mode: 'inline' }), seed: 3 });
  const tape = generateTape({ seed: 314, durationSec: 40 * 60 });
  for (const e of tape) { const { _arch, ...ev } = e; const p = desk.ingest(ev); if (p) await p; }
  desk.engine.liquidateAll('end');
  desk.runAutopsies(true);
  const lessons = memory.data.lessons.length;
  assert.ok(desk.engine.closed.length > 20, 'paper trades happened');
  assert.ok(lessons > 0, 'critic produced autopsies');
  assert.ok(Object.keys(memory.data.causeCounts).length >= 2, 'multiple loss causes identified');
  assert.ok(desk.learn.patches + desk.learn.cycles > 0, 'strategist ran');
  assert.ok(desk.engine.activeStrategies().length >= 3, 'population kept alive');
  // every promoted strategy must still respect the hard sizing cap
  for (const s of desk.engine.strategies.values()) assert.ok(s.params.sizePct <= 2 && s.params.stopLossPct <= 35);
  const msgs = desk.messages.map((m) => m.agent);
  for (const a of ['scout', 'quant', 'risk', 'exec', 'critic', 'strategist']) assert.ok(msgs.includes(a), `${a} spoke`);
});
