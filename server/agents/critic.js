// Critic agent: performs an "autopsy" on every losing trade, pinpoints the cause from the
// entry snapshot + price path + what happened AFTER we exited, and proposes concrete
// parameter rewrites (never a full rewrite — targeted fixes to entry/exit/risk rules).
import { normalizeParams } from '../core/strategy.js';

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '?');

/**
 * @param trade closed trade from the engine
 * @param after {maxPriceAfter, minPriceAfter, tradesAfter, devSoldPctAfter}
 */
export function autopsy(trade, after = {}) {
  const e = trade.entryFeatures || {};
  const p = trade.params;
  const findings = [];
  const add = (cause, weight, evidence, adjust) => findings.push({ cause, weight, evidence, adjust });
  const peak = trade.peakPnlPct;
  const recovered = after.maxPriceAfter && trade.entryPrice ? (after.maxPriceAfter / trade.entryPrice - 1) * 100 : null;

  if (trade.exitReason === 'rug_guard' || (after.devSoldPctAfter > 0.5 && e.devHoldPct > 3))
    add('dev_rug', 5, `dev held ${fmt(e.devHoldPct)}% at entry and dumped`, [
      { k: 'maxDevHoldPct', op: 'set', v: Math.max(1, Math.min(p.maxDevHoldPct * 0.75, e.devHoldPct * 0.8)) },
      { k: 'entryDelaySec', op: 'add', v: 3 },
    ]);
  if (e.bundlePct > 3)
    add('bundle_dump', 4, `${fmt(e.bundlePct)}% of supply sat in ${e.bundleWallets} bundled wallets`, [
      { k: 'maxBundlePct', op: 'set', v: Math.min(p.maxBundlePct, e.bundlePct * 0.8) },
    ]);
  if (trade.exitReason === 'dead_coin' || (after.tradesAfter != null && after.tradesAfter < 3 && trade.holdSec < 60))
    add('dead_coin', 4, `activity died: ${e.vel10} trades/10s and ${e.uniqueBuyers} buyers at entry`, [
      { k: 'minVel10', op: 'set', v: Math.max(p.minVel10 + 1.5, e.vel10 + 1) },
      { k: 'minUniqueBuyers', op: 'set', v: Math.max(p.minUniqueBuyers + 3, e.uniqueBuyers + 2) },
      { k: 'maxTradeGapSec', op: 'mul', v: 0.85 },
    ]);
  if (trade.exitReason === 'stop_loss' && recovered != null && recovered >= Math.max(15, p.takeProfitPct / 2))
    add('stop_too_tight', 3, `stopped at ${fmt(trade.pnlPct)}% then price ran to +${fmt(recovered)}% within 90s`, [
      { k: 'stopLossPct', op: 'add', v: 3 },
    ]);
  if (peak >= Math.max(12, p.takeProfitPct * 0.4) && trade.pnlPct < 0)
    add('gave_back_gains', 3, `was +${fmt(peak)}% at peak but closed ${fmt(trade.pnlPct)}%`, [
      { k: 'trailingStopPct', op: 'mul', v: 0.85 },
      { k: 'takeProfitPct', op: 'mul', v: 0.85 },
    ]);
  if (e.runupPct > 120 && peak < 8)
    add('bought_top', 3, `entered after a +${fmt(e.runupPct, 0)}% run-up and never got paid`, [
      { k: 'maxRunupPct', op: 'set', v: Math.min(p.maxRunupPct, e.runupPct * 0.8) },
    ]);
  if (e.fromPeakPct > 8 && peak < 5)
    add('falling_knife', 2, `bought ${fmt(e.fromPeakPct)}% below the local peak while it kept falling`, [
      { k: 'maxFromPeakPct', op: 'set', v: Math.min(p.maxFromPeakPct, Math.max(4, e.fromPeakPct * 0.8)) },
    ]);
  if (e.top10Pct > 35)
    add('concentrated', 2, `top-10 wallets held ${fmt(e.top10Pct)}%`, [
      { k: 'maxTop10Pct', op: 'set', v: Math.min(p.maxTop10Pct, e.top10Pct * 0.9) },
    ]);
  if (trade.exitReason === 'sell_pressure' || (e.buys > 0 && e.uniqueBuyers / e.buys < 0.45))
    add('wash_pump', 2, `only ${e.uniqueBuyers} unique buyers across ${e.buys} buys (recycled wallets)`, [
      { k: 'minUniqueBuyers', op: 'add', v: 4 },
      { k: 'minBsRatio', op: 'add', v: 0.15 },
    ]);
  if (trade.slipPct > 8)
    add('late_fill', 1, `filled ${fmt(trade.slipPct)}% above signal price (latency/competition)`, [
      { k: 'maxMcapSol', op: 'mul', v: 0.92 },
    ]);
  if (e.net30 < 0.5 && e.whaleSol30 < 1)
    add('no_flow', 1, `net inflow only ${fmt(e.net30, 2)} SOL/30s, no whale support`, [
      { k: 'minNet30', op: 'add', v: 0.5 },
    ]);

  findings.sort((a, b) => b.weight - a.weight);
  const primary = findings[0] || { cause: 'noise', weight: 0, evidence: 'no clear failure pattern; within normal variance', adjust: [] };
  return {
    tradeId: trade.id, mint: trade.mint, symbol: trade.symbol, creator: trade.creator, strategyId: trade.strategyId,
    strategyName: trade.strategyName, gen: trade.gen, pnlSol: trade.pnlSol, pnlPct: trade.pnlPct, exitReason: trade.exitReason,
    cause: primary.cause, evidence: primary.evidence, secondary: findings.slice(1, 3).map((f) => f.cause),
    adjust: primary.adjust, ts: trade.closeTs,
    text: `Autopsy $${trade.symbol} ${fmt(trade.pnlPct)}% (${trade.strategyName} g${trade.gen}): ${primary.evidence}.`,
  };
}

/** Lightweight review of winners so the team also learns what works. */
export function reviewWin(trade) {
  const e = trade.entryFeatures || {};
  const tags = [];
  if (e.whaleSol30 >= 3) tags.push('whale_backed');
  if (e.uniqueBuyers >= 30) tags.push('broad_base');
  if (trade.exitReason === 'graduated') tags.push('graduated');
  if (trade.peakPnlPct > 100) tags.push('runner');
  if (e.ageSec < 10) tags.push('early_snipe');
  return { tags, text: `Win $${trade.symbol} +${fmt(trade.pnlPct)}% via ${trade.exitReason}${tags.length ? ` [${tags.join(', ')}]` : ''}` };
}

export function applyAdjustments(params, adjustments) {
  const out = { ...params };
  for (const a of adjustments) {
    if (!(a.k in out)) continue;
    if (a.op === 'set') out[a.k] = a.v;
    else if (a.op === 'add') out[a.k] = out[a.k] + a.v;
    else if (a.op === 'mul') out[a.k] = out[a.k] * a.v;
  }
  return normalizeParams(out);
}

/** Merge several autopsies for one strategy into a single patch (most frequent causes win). */
export function consolidate(autopsies) {
  const byCause = new Map();
  for (const a of autopsies) {
    if (!a.adjust?.length) continue;
    const c = byCause.get(a.cause) || { cause: a.cause, n: 0, adjust: [] };
    c.n++; c.adjust.push(...a.adjust);
    byCause.set(a.cause, c);
  }
  const ranked = [...byCause.values()].sort((a, b) => b.n - a.n);
  const merged = new Map();
  for (const c of ranked.slice(0, 2)) {
    for (const adj of c.adjust) {
      const key = adj.k + adj.op;
      const prev = merged.get(key);
      if (!prev) merged.set(key, { ...adj });
      else if (adj.op === 'set') prev.v = adj.k.startsWith('max') ? Math.min(prev.v, adj.v) : Math.max(prev.v, adj.v);
    }
  }
  return { causes: ranked.map((c) => `${c.cause}×${c.n}`), adjust: [...merged.values()] };
}
