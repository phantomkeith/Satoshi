// Strategy genome: a set of entry filters + exit rules. The Strategist agent mutates
// and patches these; the Risk agent clamps them to hard limits before they can trade.

export const PARAM_SPACE = {
  // --- entry timing & market state
  entryDelaySec:      { min: 0,    max: 120,  desc: 'observe this long after launch before buying' },
  maxEntryAgeSec:     { min: 10,   max: 900,  desc: 'never buy coins older than this' },
  minMcapSol:         { min: 25,   max: 380 },
  maxMcapSol:         { min: 30,   max: 420 },
  minUniqueBuyers:    { min: 0,    max: 120, int: true },
  minVel10:           { min: 0,    max: 50,  desc: 'trades in last 10s (anti-dead-coin)' },
  maxTradeGapSec:     { min: 1,    max: 30,  desc: 'seconds since last trade (anti-dead-coin)' },
  minBsRatio:         { min: 0.5,  max: 6,   desc: 'lifetime buy SOL / sell SOL' },
  minNet30:           { min: -5,   max: 20,  desc: 'net SOL inflow last 30s' },
  // --- safety
  maxDevHoldPct:      { min: 0,    max: 25 },
  maxDevSoldPct:      { min: 0,    max: 1 },
  maxBundlePct:       { min: 0,    max: 50 },
  maxTop10Pct:        { min: 10,   max: 85 },
  maxRunupPct:        { min: 0,    max: 1200, desc: 'avoid buying the top' },
  maxFromPeakPct:     { min: 3,    max: 70,  desc: 'avoid falling knives' },
  requireSocials:     { min: 0,    max: 1,   int: true },
  maxCreatorRugs:     { min: 0,    max: 3,   int: true },
  // --- heavy-SOL-buy (whale) logic
  whaleBuySol:        { min: 1,    max: 10,  desc: 'a single buy this big counts as a whale buy' },
  minWhaleSol30:      { min: 0,    max: 25,  desc: 'whale SOL in last 30s required to enter' },
  whaleTrailBonusPct: { min: 0,    max: 30,  desc: 'widen trailing stop while whales keep buying' },
  whaleHoldSec:       { min: 5,    max: 180, desc: 'how long a whale buy keeps us holding' },
  // --- sizing & exits
  sizePct:            { min: 0.25, max: 2,   desc: '% of equity per trade (hard cap 2%)' },
  stopLossPct:        { min: 5,    max: 35 },
  takeProfitPct:      { min: 10,   max: 400 },
  tp1SellPct:         { min: 0,    max: 100 },
  trailingStopPct:    { min: 5,    max: 50 },
  deadExitSec:        { min: 3,    max: 90 },
  maxHoldSec:         { min: 20,   max: 2400 },
  sellPressureExit:   { min: 1.2,  max: 12 },
  devSellExitPct:     { min: 0.05, max: 1 },
};

export const BASE_PARAMS = {
  entryDelaySec: 8, maxEntryAgeSec: 120, minMcapSol: 28, maxMcapSol: 150, minUniqueBuyers: 8,
  minVel10: 4, maxTradeGapSec: 6, minBsRatio: 1.3, minNet30: 0, maxDevHoldPct: 10, maxDevSoldPct: 0.1,
  maxBundlePct: 12, maxTop10Pct: 45, maxRunupPct: 250, maxFromPeakPct: 25, requireSocials: 0,
  maxCreatorRugs: 0, whaleBuySol: 2, minWhaleSol30: 0, whaleTrailBonusPct: 10, whaleHoldSec: 45,
  sizePct: 1.5, stopLossPct: 20, takeProfitPct: 60, tp1SellPct: 50, trailingStopPct: 20,
  deadExitSec: 15, maxHoldSec: 300, sellPressureExit: 3, devSellExitPct: 0.25,
};

export const SEED_STRATEGIES = [
  {
    name: 'Lightning Snipe', archetype: 'snipe',
    thesis: 'Enter within seconds of launch if early flow is organic (many distinct buyers, no bundle, small dev bag).',
    params: { entryDelaySec: 3, maxEntryAgeSec: 20, maxMcapSol: 60, minUniqueBuyers: 4, minVel10: 3, maxTradeGapSec: 4,
      maxDevHoldPct: 8, maxBundlePct: 8, maxRunupPct: 120, stopLossPct: 22, takeProfitPct: 50, trailingStopPct: 18, maxHoldSec: 120, deadExitSec: 8 },
  },
  {
    name: 'Momentum Rider', archetype: 'momentum',
    thesis: 'Wait for proof of life: sustained velocity, broad buyer base and positive net inflow, then ride with a trailing stop.',
    params: { entryDelaySec: 25, maxEntryAgeSec: 240, minMcapSol: 40, maxMcapSol: 220, minUniqueBuyers: 25, minVel10: 8,
      minBsRatio: 1.6, minNet30: 2, maxRunupPct: 500, stopLossPct: 18, takeProfitPct: 90, trailingStopPct: 22, maxHoldSec: 480 },
  },
  {
    name: 'Whale Follower', archetype: 'whale',
    thesis: 'Heavy SOL buys signal conviction. Enter after whale flow and keep holding while whales keep adding.',
    params: { entryDelaySec: 10, maxEntryAgeSec: 360, minUniqueBuyers: 15, minVel10: 5, whaleBuySol: 2, minWhaleSol30: 5,
      whaleTrailBonusPct: 18, whaleHoldSec: 90, maxRunupPct: 600, maxMcapSol: 260, stopLossPct: 20, takeProfitPct: 120,
      tp1SellPct: 35, trailingStopPct: 24, maxHoldSec: 900 },
  },
  {
    name: 'Graduation Hunter', archetype: 'graduation',
    thesis: 'Coins that reach ~40% of the bonding curve with a wide holder base often push for graduation.',
    params: { entryDelaySec: 45, maxEntryAgeSec: 900, minMcapSol: 110, maxMcapSol: 300, minUniqueBuyers: 50, minVel10: 8,
      maxTop10Pct: 35, maxRunupPct: 1200, maxFromPeakPct: 15, stopLossPct: 15, takeProfitPct: 45, trailingStopPct: 15, maxHoldSec: 900 },
  },
  {
    name: 'Safe Scout', archetype: 'safe',
    thesis: 'Strictest safety filters: socials, tiny dev bag, no bundle, low concentration. Fewer trades, fewer rugs.',
    params: { entryDelaySec: 30, maxEntryAgeSec: 300, requireSocials: 1, maxDevHoldPct: 5, maxBundlePct: 4, maxTop10Pct: 30,
      minUniqueBuyers: 20, minVel10: 5, stopLossPct: 15, takeProfitPct: 70, trailingStopPct: 18 },
  },
];

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function clampParam(key, v) {
  const s = PARAM_SPACE[key];
  if (!s || !Number.isFinite(v)) return BASE_PARAMS[key];
  let x = Math.min(s.max, Math.max(s.min, v));
  return s.int ? Math.round(x) : round(x);
}

export function normalizeParams(p) {
  const out = {};
  for (const k of Object.keys(PARAM_SPACE)) out[k] = clampParam(k, p[k] ?? BASE_PARAMS[k]);
  if (out.maxMcapSol <= out.minMcapSol) out.maxMcapSol = clampParam('maxMcapSol', out.minMcapSol + 20);
  if (out.maxEntryAgeSec <= out.entryDelaySec) out.maxEntryAgeSec = clampParam('maxEntryAgeSec', out.entryDelaySec + 15);
  return out;
}

let idCounter = 0;
export function makeStrategy({ name, archetype = 'custom', thesis = '', params = {}, gen = 1, parent = null, family = null, origin = 'seed' }) {
  const id = `${(family || name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-g${gen}-${(Date.now() % 1e6).toString(36)}${(idCounter++).toString(36)}`;
  return { id, name, family: family || name, archetype, thesis, gen, parent, origin, createdAt: Date.now(), active: true,
    params: normalizeParams({ ...BASE_PARAMS, ...params }) };
}

export const whaleSol30 = (f, p) => f.bigBuys30.reduce((s, x) => (x >= p.whaleBuySol ? s + x : s), 0);

/** Entry decision. Returns {ok, fails[], safetyFails[], score}. */
export function evaluateEntry(f, p, ctx = {}) {
  const fails = [], safety = [];
  if (f.migrated) fails.push('migrated');
  if (f.ageSec < p.entryDelaySec) fails.push('too_early');
  if (f.ageSec > p.maxEntryAgeSec) fails.push('too_old');
  if (f.mcapSol < p.minMcapSol) fails.push('mcap_low');
  if (f.mcapSol > p.maxMcapSol) fails.push('mcap_high');
  if (f.uniqueBuyers < p.minUniqueBuyers) fails.push('few_buyers');
  if (f.vel10 < p.minVel10) fails.push('dead_velocity');
  if (f.tradeGapSec > p.maxTradeGapSec) fails.push('dead_gap');
  if (f.bsRatio < p.minBsRatio) fails.push('weak_bs');
  if (f.net30 < p.minNet30) fails.push('outflow');
  if (f.runupPct > p.maxRunupPct) fails.push('chasing_top');
  if (f.fromPeakPct > p.maxFromPeakPct) fails.push('falling_knife');
  const w = whaleSol30(f, p);
  if (w < p.minWhaleSol30) fails.push('no_whales');
  if (fails.length && !ctx.full) return { ok: false, fails, safetyFails: safety, score: 0, whale: w };
  // safety (Sentinel)
  if (f.devHoldPct > p.maxDevHoldPct) safety.push('dev_bag');
  if (f.devSoldPct > p.maxDevSoldPct) safety.push('dev_selling');
  if (f.bundlePct > p.maxBundlePct) safety.push('bundled');
  if (f.top10Pct > p.maxTop10Pct) safety.push('concentrated');
  if (p.requireSocials && f.hasSocials === false) safety.push('no_socials');
  if ((ctx.creatorRugs || 0) > p.maxCreatorRugs) safety.push('serial_rugger');

  const score = scoreToken(f, w);
  return { ok: fails.length === 0 && safety.length === 0, fails, safetyFails: safety, score, whale: w };
}

/** 0..100 composite "Quant" score used for ranking and the UI. */
export function scoreToken(f, whale = 0) {
  const c = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
  let s = 0;
  s += 22 * c(f.uniqueBuyers, 3, 60);
  s += 18 * c(f.vel10, 1, 20);
  s += 14 * c(f.bsRatio, 0.8, 3);
  s += 12 * c(whale, 0, 10);
  s += 10 * c(f.net30, -1, 8);
  s += 8 * (1 - c(f.devHoldPct, 2, 15));
  s += 8 * (1 - c(f.bundlePct, 2, 25));
  s += 5 * (1 - c(f.top10Pct, 20, 70));
  s += 3 * (f.hasSocials ? 1 : 0);
  if (f.devSoldPct > 0.2) s *= 0.4;
  if (f.tradeGapSec > 10) s *= 0.5;
  return Math.round(s);
}

/**
 * Exit decision for an open position. Returns null or {fraction, reason}.
 * pos: {entryPrice, peakPrice, tp1Hit, openTs}
 */
export function checkExit(pos, f, now, p) {
  if (f.migrated) return { fraction: 1, reason: 'graduated' };
  const pnlPct = (f.price / pos.entryPrice - 1) * 100;
  if (f.devSoldPct >= p.devSellExitPct && f.devSoldPct > pos.entryDevSoldPct + 0.02) return { fraction: 1, reason: 'rug_guard' };
  if (pnlPct <= -p.stopLossPct) return { fraction: 1, reason: 'stop_loss' };
  if (!pos.tp1Hit && pnlPct >= p.takeProfitPct && p.tp1SellPct > 0) return { fraction: Math.min(1, p.tp1SellPct / 100), reason: 'take_profit', tp1: true };

  const whaleActive = f.lastBigBuyTs && f.lastBigBuySol >= p.whaleBuySol && (now - f.lastBigBuyTs) / 1000 <= p.whaleHoldSec;
  const trail = p.trailingStopPct + (whaleActive ? p.whaleTrailBonusPct : 0);
  const peakPnl = (pos.peakPrice / pos.entryPrice - 1) * 100;
  // Trailing stop arms once in profit; protects gains while letting runners run.
  if (peakPnl > Math.min(15, p.takeProfitPct / 2) && f.price <= pos.peakPrice * (1 - trail / 100)) return { fraction: 1, reason: 'trailing_stop' };
  if (f.tradeGapSec >= p.deadExitSec) return { fraction: 1, reason: 'dead_coin' };
  if (f.sellPressure30 >= p.sellPressureExit && f.sellVol30 > 1 && !whaleActive) return { fraction: 1, reason: 'sell_pressure' };
  const held = (now - pos.openTs) / 1000;
  const maxHold = whaleActive ? p.maxHoldSec * 2 : p.maxHoldSec;
  if (held >= maxHold) return { fraction: 1, reason: 'time_exit' };
  return null;
}

/** Fitness used by the Strategist to compare candidates (SOL-denominated). */
export function fitness(stats, { minTrades = 4 } = {}) {
  if (!stats || stats.n < minTrades) return -1000 + (stats?.n || 0);
  const pf = stats.grossLoss > 0 ? stats.grossWin / stats.grossLoss : stats.grossWin > 0 ? 5 : 0;
  return round(stats.pnl - 0.5 * stats.maxDD + 0.02 * Math.min(pf, 5) * Math.sqrt(stats.n), 4);
}

export function diffParams(a, b) {
  const out = [];
  for (const k of Object.keys(PARAM_SPACE)) if (a[k] !== b[k]) out.push({ k, from: a[k], to: b[k] });
  return out;
}
