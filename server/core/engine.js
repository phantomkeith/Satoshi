import { TokenState } from './tokenState.js';
import { buyQuote, sellQuote, PUMP_FEE } from './curve.js';
import { evaluateEntry, checkExit } from './strategy.js';
import { RiskManager } from './risk.js';
import { Rng } from '../util/rng.js';

export const DEFAULT_EXEC = {
  latencyMs: 400,          // detection -> landed tx (RPC + Jito bundle) in paper simulation
  failRate: 0.06,          // fraction of txs that fail to land
  priorityFeeSol: 0.0003,
  jitoTipSol: 0.0005,
  failedTxFeeSol: 0.00001,
};

const emptyStats = () => ({ n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, cum: 0, peak: 0, maxDD: 0, lastTs: 0, fails: 0 });

/**
 * Deterministic event-driven trading engine. The same code runs live (paper) and in
 * backtests: feed it normalized events in timestamp order via handle(e).
 */
export class Engine {
  constructor({ strategies = [], startingSol = 10, exec = {}, seed = 7, emit = () => {}, creatorRugs = () => 0,
    evalThrottleMs = 300, pruneAfterSec = 900, fixedSizing = false } = {}) {
    this.fixedSizing = fixedSizing; // size off starting equity (no compounding) for fair comparisons
    this.exec = { ...DEFAULT_EXEC, ...exec };
    this.rng = new Rng(seed);
    this.emit = emit;
    this.creatorRugs = creatorRugs;
    this.evalThrottleMs = evalThrottleMs;
    this.pruneAfterSec = pruneAfterSec;
    this.now = 0;
    this.startingSol = startingSol;
    this.cash = startingSol;
    this.tokens = new Map();
    this.strategies = new Map();
    this.stats = new Map();
    this.positions = new Map();
    this.byMint = new Map();
    this.pending = [];
    this.entered = new Set();
    this.lastEval = new Map();
    this.closed = [];
    this.equityHist = [];
    this.lastEquityTs = 0;
    this.seq = 0;
    this.risk = new RiskManager(startingSol);
    for (const s of strategies) this.addStrategy(s);
  }

  addStrategy(s) { this.strategies.set(s.id, s); if (!this.stats.has(s.id)) this.stats.set(s.id, emptyStats()); }
  retireStrategy(id) { const s = this.strategies.get(id); if (s) s.active = false; }
  activeStrategies() { return [...this.strategies.values()].filter((s) => s.active); }

  handle(e) {
    if (e.ts > this.now) {
      const prev = this.now;
      this.now = e.ts;
      if (Math.floor(prev / 1000) !== Math.floor(e.ts / 1000)) this.tick();
    }
    switch (e.type) {
      case 'create': {
        if (this.tokens.has(e.mint)) return;
        const t = new TokenState(e);
        this.tokens.set(e.mint, t);
        this.emit('create', t);
        break;
      }
      case 'trade': {
        const t = this.tokens.get(e.mint);
        if (!t) return;
        t.onTrade(e);
        this.fillDue();
        this.manage(t);
        this.evaluate(t);
        break;
      }
      case 'migrate': {
        const t = this.tokens.get(e.mint);
        if (!t) return;
        t.migrated = true; t._fCache = null;
        this.emit('migrate', t);
        this.manage(t);
        break;
      }
      case 'meta': {
        const t = this.tokens.get(e.mint);
        if (!t) return;
        if (e.socials) t.socials = e.socials;
        if (e.image) t.image = e.image;
        t._fCache = null;
        break;
      }
    }
  }

  /** Advance clock without an event (live mode heartbeat). */
  advance(ts) { if (ts > this.now) { this.now = ts; this.tick(); } }

  tick() {
    this.fillDue();
    for (const mint of this.byMint.keys()) { const t = this.tokens.get(mint); if (t) this.manage(t); }
    if (this.now - this.lastEquityTs >= 5000) {
      this.lastEquityTs = this.now;
      const eq = this.equity();
      this.equityHist.push([this.now, +eq.toFixed(5)]);
      if (this.equityHist.length > 20000) this.equityHist = this.equityHist.filter((_, i) => i % 2 === 0);
      const r = this.risk.onEquity(eq, this.now);
      if (r) this.emit('risk', r);
      this.emit('equity', { ts: this.now, equity: eq });
    }
    if (this.now % 15000 < 1000) this.prune();
  }

  prune() {
    const gone = [];
    for (const [mint, t] of this.tokens) {
      if (this.byMint.has(mint)) continue;
      const age = (this.now - t.createdTs) / 1000;
      const gap = (this.now - t.lastTradeTs) / 1000;
      if (age > this.pruneAfterSec || (age > 180 && gap > 90) || (age > 60 && t.trades.length < 3 && gap > 45)) {
        this.tokens.delete(mint); this.lastEval.delete(mint); gone.push(mint);
      }
    }
    if (gone.length) this.emit('prune', gone);
  }

  equity() {
    let v = this.cash;
    for (const p of this.positions.values()) {
      const t = this.tokens.get(p.mint);
      if (t && p.tokensLeft > 0) v += sellQuote(t.vSol, t.vTok, p.tokensLeft);
    }
    return v;
  }

  openCost() {
    let c = 0;
    for (const p of this.positions.values()) c += p.costSol * (p.tokensLeft / p.tokens);
    for (const o of this.pending) if (o.kind === 'buy') c += o.sizeSol;
    return c;
  }

  evaluate(t) {
    const last = this.lastEval.get(t.mint) || 0;
    if (this.now - last < this.evalThrottleMs) return;
    this.lastEval.set(t.mint, this.now);
    const age = (this.now - t.createdTs) / 1000;
    let f = null;
    for (const s of this.strategies.values()) {
      if (!s.active) continue;
      const key = s.id + '|' + t.mint;
      if (this.entered.has(key)) continue;
      const sp = s.params;
      if (age > sp.maxEntryAgeSec || age < sp.entryDelaySec) continue;
      // cheap prefilters before computing the feature vector
      const mc = t.mcap;
      if (mc < sp.minMcapSol || mc > sp.maxMcapSol || t.buyers.size < sp.minUniqueBuyers || (this.now - t.lastTradeTs) / 1000 > sp.maxTradeGapSec) continue;
      f ??= t.features(this.now);
      const r = evaluateEntry(f, s.params, { creatorRugs: this.creatorRugs(t.creator) });
      if (!r.ok) {
        if (r.fails.length === 0) this.emit('blocked', { token: t, strategy: s, r });
        continue;
      }
      const mintHolders = (this.byMint.get(t.mint)?.size || 0) + this.pending.filter((o) => o.kind === 'buy' && o.mint === t.mint).length;
      const openPositions = this.positions.size + this.pending.filter((o) => o.kind === 'buy').length;
      const eq = this.equity();
      const a = this.risk.approve({ params: s.params, equity: this.fixedSizing ? Math.min(eq, this.startingSol) : eq, cash: this.cash, openPositions, openCost: this.openCost(), mintHolders, now: this.now });
      if (!a.ok) { this.emit('riskReject', { token: t, strategy: s, reason: a.reason, r }); continue; }
      if (a.sizeSol + this.exec.priorityFeeSol + this.exec.jitoTipSol > this.cash) continue;
      this.entered.add(key);
      const o = { id: ++this.seq, kind: 'buy', strategyId: s.id, mint: t.mint, sizeSol: a.sizeSol, signalPrice: f.price,
        due: this.now + this.exec.latencyMs, ts: this.now, features: snapshot(f), score: r.score, whale: r.whale };
      this.pending.push(o);
      this.emit('signal', { order: o, token: t, strategy: s, r });
    }
  }

  manage(t) {
    const ids = this.byMint.get(t.mint);
    if (!ids) return;
    const f = t.features(this.now);
    for (const id of ids) {
      const pos = this.positions.get(id);
      if (!pos || pos.pendingSell) continue;
      if (f.price > pos.peakPrice) pos.peakPrice = f.price;
      if (f.price < pos.minPrice) pos.minPrice = f.price;
      if (this.now - pos.lastPathTs >= 2000) { pos.path.push([this.now, f.price]); pos.lastPathTs = this.now; if (pos.path.length > 600) pos.path.splice(1, 1); }
      const ex = checkExit(pos, f, this.now, pos.params);
      if (!ex) continue;
      if (ex.tp1) pos.tp1Hit = true;
      pos.pendingSell = true;
      this.pending.push({ id: ++this.seq, kind: 'sell', posId: pos.id, mint: t.mint, fraction: ex.fraction, reason: ex.reason,
        due: this.now + this.exec.latencyMs, ts: this.now, signalPrice: f.price, tries: 0 });
    }
  }

  fillDue() {
    if (!this.pending.length) return;
    const due = [], keep = [];
    for (const o of this.pending) (o.due <= this.now ? due : keep).push(o);
    if (!due.length) return;
    this.pending = keep;
    for (const o of due) (o.kind === 'buy' ? this.fillBuy(o) : this.fillSell(o));
  }

  fillBuy(o) {
    const t = this.tokens.get(o.mint);
    const s = this.strategies.get(o.strategyId);
    const stats = this.stats.get(o.strategyId);
    if (!t || !s) return;
    const fees = this.exec.priorityFeeSol + this.exec.jitoTipSol;
    if (this.rng.chance(this.exec.failRate)) {
      this.cash -= this.exec.failedTxFeeSol; stats.fails++;
      this.emit('fail', { order: o, token: t, reason: 'tx did not land' });
      return;
    }
    const slip = (t.price / o.signalPrice - 1) * 100;
    if (slip > this.risk.L.maxSlippagePct) {
      this.cash -= this.exec.failedTxFeeSol; stats.fails++;
      this.emit('fail', { order: o, token: t, reason: `slippage ${slip.toFixed(1)}% > ${this.risk.L.maxSlippagePct}%` });
      return;
    }
    const tokens = buyQuote(t.vSol, t.vTok, o.sizeSol);
    this.cash -= o.sizeSol + fees;
    const entryPrice = (o.sizeSol * (1 - PUMP_FEE)) / tokens;
    const pos = {
      id: `p${++this.seq}`, strategyId: s.id, strategyName: s.name, gen: s.gen, params: { ...s.params },
      mint: t.mint, symbol: t.symbol, name: t.name, creator: t.creator,
      openTs: this.now, signalTs: o.ts, entryPrice, signalPrice: o.signalPrice, slipPct: slip,
      tokens, tokensLeft: tokens, costSol: o.sizeSol + fees, proceedsSol: 0,
      peakPrice: entryPrice, minPrice: entryPrice, tp1Hit: false, pendingSell: false,
      entryFeatures: o.features, entryDevSoldPct: o.features.devSoldPct, score: o.score,
      path: [[this.now, entryPrice]], lastPathTs: this.now, exits: [], whaleBuysDuring: 0,
    };
    this.positions.set(pos.id, pos);
    if (!this.byMint.has(t.mint)) this.byMint.set(t.mint, new Set());
    this.byMint.get(t.mint).add(pos.id);
    this.emit('open', { pos, token: t });
  }

  fillSell(o) {
    const pos = this.positions.get(o.posId);
    const t = this.tokens.get(o.mint);
    if (!pos || !t) return;
    const fees = this.exec.priorityFeeSol + this.exec.jitoTipSol;
    if (this.rng.chance(this.exec.failRate) && o.tries < 5) {
      this.cash -= this.exec.failedTxFeeSol;
      o.tries++; o.due = this.now + this.exec.latencyMs;
      this.pending.push(o); // sells always retry
      return;
    }
    const qty = o.fraction >= 0.999 ? pos.tokensLeft : pos.tokensLeft * o.fraction;
    const sol = Math.max(0, sellQuote(t.vSol, t.vTok, qty) - fees);
    this.cash += sol;
    pos.tokensLeft -= qty;
    pos.proceedsSol += sol;
    pos.exits.push({ ts: this.now, reason: o.reason, fraction: o.fraction, sol, price: t.price });
    pos.pendingSell = false;
    this.emit('partial', { pos, token: t, reason: o.reason, sol });
    if (pos.tokensLeft <= pos.tokens * 1e-6) this.close(pos, o.reason);
  }

  close(pos, reason) {
    this.positions.delete(pos.id);
    const set = this.byMint.get(pos.mint);
    if (set) { set.delete(pos.id); if (!set.size) this.byMint.delete(pos.mint); }
    const pnlSol = pos.proceedsSol - pos.costSol;
    const trade = {
      id: pos.id, strategyId: pos.strategyId, strategyName: pos.strategyName, gen: pos.gen, mint: pos.mint, symbol: pos.symbol,
      name: pos.name, creator: pos.creator, openTs: pos.openTs, closeTs: this.now, holdSec: (this.now - pos.openTs) / 1000,
      costSol: pos.costSol, proceedsSol: pos.proceedsSol, pnlSol, pnlPct: (pnlSol / pos.costSol) * 100,
      exitReason: reason, exits: pos.exits, entryFeatures: pos.entryFeatures, params: pos.params, slipPct: pos.slipPct,
      peakPnlPct: (pos.peakPrice / pos.entryPrice - 1) * 100, maxAdversePct: (pos.minPrice / pos.entryPrice - 1) * 100,
      entryPrice: pos.entryPrice, path: pos.path, score: pos.score,
    };
    const st = this.stats.get(pos.strategyId) || emptyStats();
    st.n++; st.pnl += pnlSol; st.cum += pnlSol; st.lastTs = this.now;
    if (pnlSol > 0) { st.wins++; st.grossWin += pnlSol; } else st.grossLoss += -pnlSol;
    if (st.cum > st.peak) st.peak = st.cum;
    st.maxDD = Math.max(st.maxDD, st.peak - st.cum);
    this.stats.set(pos.strategyId, st);
    this.closed.push(trade);
    if (this.closed.length > 2000) this.closed.splice(0, 500);
    const r = this.risk.onClose(pnlSol, this.now);
    if (r) this.emit('risk', r);
    this.emit('close', trade);
  }

  /** Liquidate everything at the current curve price (end of backtest / reset). */
  liquidateAll(reason = 'end') {
    for (const pos of [...this.positions.values()]) {
      const t = this.tokens.get(pos.mint);
      const sol = t ? Math.max(0, sellQuote(t.vSol, t.vTok, pos.tokensLeft)) : 0;
      this.cash += sol; pos.proceedsSol += sol; pos.tokensLeft = 0;
      pos.exits.push({ ts: this.now, reason, fraction: 1, sol });
      this.close(pos, reason);
    }
    this.pending = [];
  }
}

function snapshot(f) {
  const { bigBuys30, ...rest } = f;
  const o = {};
  for (const [k, v] of Object.entries(rest)) o[k] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  o.whaleSol30 = Math.round(bigBuys30.reduce((a, b) => a + b, 0) * 1000) / 1000;
  return o;
}
