import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buyQuote, sellQuote, INITIAL_VSOL, INITIAL_VTOK, INITIAL_MCAP, PUMP_FEE, applyBuy } from '../server/core/curve.js';
import { TokenState } from '../server/core/tokenState.js';
import { RiskManager, HARD_LIMITS } from '../server/core/risk.js';
import { normalizeParams, evaluateEntry, checkExit, makeStrategy, SEED_STRATEGIES, BASE_PARAMS, PARAM_SPACE } from '../server/core/strategy.js';
import { Engine } from '../server/core/engine.js';
import { generateTape } from '../server/sim/market.js';
import { decodePumpEvent } from '../server/feeds/solanaRpc.js';
import { base58Encode } from '../server/util/base58.js';

test('bonding curve: initial mcap and round-trip costs only fees', () => {
  assert.ok(Math.abs(INITIAL_MCAP - 27.96) < 0.05);
  const tok = buyQuote(INITIAL_VSOL, INITIAL_VTOK, 1);
  const after = applyBuy(INITIAL_VSOL, INITIAL_VTOK, 1);
  const back = sellQuote(after.vSol, after.vTok, tok);
  const expected = (1 - PUMP_FEE) * (1 - PUMP_FEE);
  assert.ok(Math.abs(back - expected) < 1e-9, `round trip ${back} vs ${expected}`);
});

test('token state: detects bundled launch, dev bag and dev selling', () => {
  const t0 = 1_000_000;
  const dev = 'DEV', creatorTokens = 30_000_000;
  const t = new TokenState({ ts: t0, slot: 10, mint: 'M', symbol: 'X', creator: dev, vSol: 31, vTok: 1_038_000_000, initialBuyTokens: creatorTokens, initialBuySol: 1 });
  t.onTrade({ ts: t0 + 100, slot: 10, mint: 'M', trader: 'B1', side: 'buy', sol: 2, tokens: 60_000_000 });
  t.onTrade({ ts: t0 + 200, slot: 10, mint: 'M', trader: 'B2', side: 'buy', sol: 2, tokens: 55_000_000 });
  t.onTrade({ ts: t0 + 3000, slot: 18, mint: 'M', trader: 'R1', side: 'buy', sol: 0.3, tokens: 8_000_000 });
  let f = t.features(t0 + 3500);
  assert.equal(f.bundleWallets, 2);
  assert.ok(f.bundlePct > 11 && f.bundlePct < 12, `bundle ${f.bundlePct}`);
  assert.ok(Math.abs(f.devHoldPct - 3) < 1e-9);
  assert.equal(f.uniqueBuyers, 3);
  t.onTrade({ ts: t0 + 4000, slot: 20, mint: 'M', trader: dev, side: 'sell', sol: 0.5, tokens: 15_000_000 });
  f = t.features(t0 + 4500);
  assert.equal(f.devSoldPct, 0.5);
  assert.ok(f.top10Pct > 0);
  // dead coin: gap grows with the clock
  assert.ok(t.features(t0 + 64_500).tradeGapSec >= 60);
});

test('risk: never more than 2% of equity per trade, kill switch, mandatory stop', () => {
  const r = new RiskManager(10);
  const params = normalizeParams({ ...BASE_PARAMS, sizePct: 50 });
  assert.equal(params.sizePct, 2, 'sizePct clamped to hard 2% cap');
  const a = r.approve({ params, equity: 10, cash: 10, openPositions: 0, openCost: 0, mintHolders: 0, now: 0 });
  assert.ok(a.ok); assert.ok(a.sizeSol <= 0.2 + 1e-12);
  const big = r.approve({ params, equity: 1000, cash: 1000, openPositions: 0, openCost: 0, mintHolders: 0, now: 0 });
  assert.ok(big.sizeSol <= HARD_LIMITS.maxPositionSol);
  assert.equal(r.approve({ params: { ...params, stopLossPct: 80 }, equity: 10, cash: 10, openPositions: 0, openCost: 0, mintHolders: 0, now: 0 }).ok, false);
  assert.equal(r.approve({ params, equity: 10, cash: 10, openPositions: HARD_LIMITS.maxOpenPositions, openCost: 0, mintHolders: 0, now: 0 }).ok, false);
  r.onEquity(10, 0);
  assert.equal(r.onEquity(7.4, 1000).event, 'kill');
  assert.equal(r.approve({ params, equity: 7.4, cash: 7.4, openPositions: 0, openCost: 0, mintHolders: 0, now: 2000 }).ok, false);
});

test('risk: loss streak triggers cooldown', () => {
  const r = new RiskManager(10);
  let ev;
  for (let i = 0; i < HARD_LIMITS.lossStreakPause; i++) ev = r.onClose(-0.1, 1000);
  assert.equal(ev.event, 'cooldown');
  const params = normalizeParams(BASE_PARAMS);
  assert.equal(r.approve({ params, equity: 10, cash: 10, openPositions: 0, openCost: 0, mintHolders: 0, now: 2000 }).ok, false);
});

test('strategy params are always clamped into the allowed space', () => {
  const wild = Object.fromEntries(Object.keys(PARAM_SPACE).map((k) => [k, 1e9]));
  const p = normalizeParams(wild);
  for (const [k, s] of Object.entries(PARAM_SPACE)) assert.ok(p[k] >= s.min && p[k] <= s.max, k);
  assert.ok(p.stopLossPct <= HARD_LIMITS.maxStopLossPct);
});

test('entry filters reject dead and bundled coins, exits fire on rug and stop', () => {
  const p = normalizeParams(BASE_PARAMS);
  const good = { ageSec: 20, mcapSol: 50, price: 5e-8, uniqueBuyers: 30, vel10: 10, tradeGapSec: 1, bsRatio: 2, net30: 3, runupPct: 80,
    fromPeakPct: 5, bigBuys30: [3], devHoldPct: 3, devSoldPct: 0, bundlePct: 2, top10Pct: 25, hasSocials: true, migrated: false, sellPressure30: 0.3, sellVol30: 1 };
  assert.equal(evaluateEntry(good, p).ok, true);
  assert.ok(evaluateEntry({ ...good, vel10: 0, tradeGapSec: 20 }, p).fails.includes('dead_velocity'));
  const b = evaluateEntry({ ...good, bundlePct: 30 }, p);
  assert.equal(b.ok, false); assert.ok(b.safetyFails.includes('bundled'));
  const pos = { entryPrice: 5e-8, peakPrice: 5e-8, tp1Hit: false, openTs: 0, entryDevSoldPct: 0 };
  assert.equal(checkExit(pos, { ...good, devSoldPct: 0.9 }, 1000, p).reason, 'rug_guard');
  assert.equal(checkExit(pos, { ...good, price: 3e-8 }, 1000, p).reason, 'stop_loss');
  assert.equal(checkExit(pos, { ...good, tradeGapSec: 60 }, 1000, p).reason, 'dead_coin');
});

test('heavy SOL buys keep a winner open (whale-widened trailing stop)', () => {
  const p = normalizeParams({ ...BASE_PARAMS, trailingStopPct: 15, whaleTrailBonusPct: 20, whaleBuySol: 2, whaleHoldSec: 60, takeProfitPct: 400 });
  const base = { ageSec: 100, mcapSol: 120, uniqueBuyers: 60, vel10: 10, tradeGapSec: 1, bsRatio: 2, net30: 3, runupPct: 200, fromPeakPct: 18,
    bigBuys30: [], devHoldPct: 2, devSoldPct: 0, bundlePct: 0, top10Pct: 20, hasSocials: true, migrated: false, sellPressure30: 1, sellVol30: 2 };
  const pos = { entryPrice: 1, peakPrice: 2, tp1Hit: false, openTs: 0, entryDevSoldPct: 0 };
  const noWhale = checkExit(pos, { ...base, price: 1.64, lastBigBuyTs: 0, lastBigBuySol: 0 }, 50_000, p);
  assert.equal(noWhale?.reason, 'trailing_stop');
  const whale = checkExit(pos, { ...base, price: 1.64, lastBigBuyTs: 40_000, lastBigBuySol: 5 }, 50_000, p);
  assert.equal(whale, null, 'should keep holding while whales are buying');
});

test('simulator is deterministic and engine results are reproducible', () => {
  const a = generateTape({ seed: 9, durationSec: 600 });
  const b = generateTape({ seed: 9, durationSec: 600 });
  assert.equal(a.length, b.length);
  assert.deepEqual(a.slice(0, 50), b.slice(0, 50));
  const run = () => {
    const eng = new Engine({ strategies: SEED_STRATEGIES.map((s) => ({ ...makeStrategy(s), id: s.name })), seed: 3 });
    for (const e of a) eng.handle(e);
    eng.liquidateAll();
    return eng.closed.map((t) => [t.mint, t.strategyId, +t.pnlSol.toFixed(9)]);
  };
  assert.deepEqual(run(), run());
});

test('engine: every paper trade respects the 2% sizing cap and exposure limits', () => {
  const tape = generateTape({ seed: 21, durationSec: 1800 });
  let maxOpen = 0;
  const eng = new Engine({ strategies: SEED_STRATEGIES.map((s) => makeStrategy({ ...s, params: { ...s.params, sizePct: 2 } })), seed: 4,
    emit: (k, d) => {
      if (k === 'signal') assert.ok(d.order.sizeSol <= eng.equity() * 0.02 + 1e-9, 'size above 2%');
      if (k === 'open') maxOpen = Math.max(maxOpen, eng.positions.size);
    } });
  for (const e of tape) eng.handle(e);
  eng.liquidateAll();
  assert.ok(eng.closed.length > 10, 'should trade');
  assert.ok(maxOpen <= HARD_LIMITS.maxOpenPositions);
  assert.ok(eng.cash > 0);
});

test('solana rpc decoder parses Pump.fun Anchor events', () => {
  const disc = (n) => crypto.createHash('sha256').update(`event:${n}`).digest().subarray(0, 8);
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const pk = (n) => Buffer.alloc(32, n);
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const create = Buffer.concat([disc('CreateEvent'), str('Test Coin'), str('TEST'), str('ipfs://x'), pk(1), pk(2), pk(3), pk(4), u64(1_700_000_000),
    u64(1_073_000_000_000_000), u64(30_000_000_000), u64(793_100_000_000_000), u64(1_000_000_000_000_000)]);
  const c = decodePumpEvent(create.toString('base64'));
  assert.equal(c.kind, 'create'); assert.equal(c.symbol, 'TEST'); assert.equal(c.mint, base58Encode(pk(1)));
  assert.equal(c.creator, base58Encode(pk(4))); assert.equal(c.vSol, 30); assert.equal(c.vTok, 1_073_000_000);
  const trade = Buffer.concat([disc('TradeEvent'), pk(1), u64(500_000_000), u64(17_000_000_000_000), Buffer.from([1]), pk(5), u64(1_700_000_001), u64(30_500_000_000), u64(1_056_000_000_000_000)]);
  const t = decodePumpEvent(trade.toString('base64'));
  assert.equal(t.kind, 'trade'); assert.equal(t.isBuy, true); assert.equal(t.sol, 0.5); assert.equal(t.tokens, 17_000_000); assert.equal(t.vSol, 30.5);
});
