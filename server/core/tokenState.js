import { mcapSol, INITIAL_MCAP, INITIAL_VSOL, GRADUATION_REAL_SOL, TOTAL_SUPPLY, applyBuy, applySell } from './curve.js';

const MAX_TRADES = 3000;
const BUNDLE_WINDOW_MS = 1200; // buys this close to launch (or same slot) are treated as bundled

/**
 * Live state for one Pump.fun coin, built purely from normalized feed events:
 *   create: { type, ts, mint, name, symbol, uri, creator, vSol, vTok, initialBuyTokens, initialBuySol, slot?, socials? }
 *   trade:  { type, ts, mint, trader, side, sol, tokens, vSol?, vTok?, slot? }
 */
export class TokenState {
  constructor(c) {
    this.mint = c.mint;
    this.name = c.name || '';
    this.symbol = c.symbol || '';
    this.uri = c.uri || '';
    this.image = c.image || null;
    this.creator = c.creator;
    this.createdTs = c.ts;
    this.createSlot = c.slot ?? null;
    this.vSol = c.vSol ?? INITIAL_VSOL;
    this.vTok = c.vTok ?? 1_073_000_000;
    this.socials = c.socials ?? null; // null = unknown, otherwise {twitter, telegram, website}
    this.trades = [];
    this.holders = new Map();
    this.buyers = new Set();
    this.sellers = new Set();
    this.devInitial = c.initialBuyTokens || 0;
    this.devSoldTokens = 0;
    this.bundleWallets = new Set();
    this.bundleTokens = 0;
    this.buys = 0; this.sells = 0;
    this.buyVol = (c.initialBuySol || 0); this.sellVol = 0;
    this.lastTradeTs = c.ts;
    this.migrated = false;
    this.peakPrice = this.price;
    this.peakMcap = this.mcap;
    if (this.devInitial > 0) this.holders.set(this.creator, this.devInitial);
    this._fCache = null;
  }

  get price() { return this.vSol / this.vTok; }
  get mcap() { return mcapSol(this.vSol, this.vTok); }
  get realSol() { return Math.max(0, this.vSol - INITIAL_VSOL); }

  onTrade(t) {
    // Prefer reserves reported by the feed (authoritative); otherwise apply curve math.
    if (t.vSol != null && t.vTok != null) { this.vSol = t.vSol; this.vTok = t.vTok; }
    else if (t.side === 'buy') ({ vSol: this.vSol, vTok: this.vTok } = applyBuy(this.vSol, this.vTok, t.sol));
    else ({ vSol: this.vSol, vTok: this.vTok } = applySell(this.vSol, this.vTok, t.tokens));

    const held = this.holders.get(t.trader) || 0;
    if (t.side === 'buy') {
      this.buys++; this.buyVol += t.sol; this.buyers.add(t.trader);
      this.holders.set(t.trader, held + t.tokens);
      const inBundle = t.trader !== this.creator && (
        (t.slot != null && this.createSlot != null) ? t.slot === this.createSlot : (t.ts - this.createdTs) <= BUNDLE_WINDOW_MS);
      if (inBundle) { this.bundleWallets.add(t.trader); this.bundleTokens += t.tokens; }
    } else {
      this.sells++; this.sellVol += t.sol; this.sellers.add(t.trader);
      const left = held - t.tokens;
      if (left > 1) this.holders.set(t.trader, left); else this.holders.delete(t.trader);
      if (t.trader === this.creator) this.devSoldTokens += t.tokens;
    }
    const p = this.price;
    if (p > this.peakPrice) { this.peakPrice = p; this.peakMcap = this.mcap; }
    this.lastTradeTs = t.ts;
    this.trades.push({ ts: t.ts, side: t.side, sol: t.sol, tokens: t.tokens, trader: t.trader, price: p });
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
    this._fCache = null;
  }

  /** Feature vector the agents reason over. Cached per 250ms of clock time. */
  features(now) {
    const bucket = Math.floor(now / 250);
    if (this._fCache && this._fCache.bucket === bucket) return this._fCache.f;

    let vel10 = 0, buyVol30 = 0, sellVol30 = 0, buys30 = 0, sells30 = 0;
    const bigBuys30 = [];
    let lastBigBuyTs = 0, lastBigBuySol = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      const age = now - t.ts;
      if (age > 120_000) break;
      if (t.side === 'buy' && t.sol >= 1 && !lastBigBuyTs) { lastBigBuyTs = t.ts; lastBigBuySol = t.sol; }
      if (age > 30_000) continue;
      if (age <= 10_000) vel10++;
      if (t.side === 'buy') { buyVol30 += t.sol; buys30++; if (t.sol >= 1) bigBuys30.push(t.sol); }
      else { sellVol30 += t.sol; sells30++; }
    }

    const devHeld = this.holders.get(this.creator) || 0;
    const s = this.socials;
    const f = {
      ageSec: (now - this.createdTs) / 1000,
      mcapSol: this.mcap,
      price: this.price,
      uniqueBuyers: this.buyers.size,
      holders: this.holders.size,
      buys: this.buys,
      sells: this.sells,
      buyVolSol: this.buyVol,
      sellVolSol: this.sellVol,
      bsRatio: this.buyVol / Math.max(this.sellVol, 0.05),
      vel10,
      buys30, sells30, buyVol30, sellVol30,
      net30: buyVol30 - sellVol30,
      sellPressure30: sellVol30 / Math.max(buyVol30, 0.05),
      bigBuys30,
      lastBigBuyTs, lastBigBuySol,
      devHoldPct: (devHeld / TOTAL_SUPPLY) * 100,
      devSoldPct: this.devInitial > 0 ? Math.min(1, this.devSoldTokens / this.devInitial) : 0,
      bundleWallets: this.bundleWallets.size,
      runupPct: (this.mcap / INITIAL_MCAP - 1) * 100,
      fromPeakPct: (1 - this.price / this.peakPrice) * 100,
      tradeGapSec: (now - this.lastTradeTs) / 1000,
      hasSocials: s == null ? null : !!(s.twitter || s.telegram || s.website),
      progressPct: Math.min(100, (this.realSol / GRADUATION_REAL_SOL) * 100),
      migrated: this.migrated,
    };
    // Expensive holder-distribution features are computed lazily, only if a strategy gets that far.
    let bundlePct, top10Pct;
    const self = this;
    Object.defineProperty(f, 'bundlePct', { enumerable: true, get() {
      if (bundlePct === undefined) { let h = 0; for (const w of self.bundleWallets) h += self.holders.get(w) || 0; bundlePct = (h / TOTAL_SUPPLY) * 100; }
      return bundlePct; } });
    Object.defineProperty(f, 'top10Pct', { enumerable: true, get() {
      if (top10Pct === undefined) top10Pct = (self.topHolders(10) / TOTAL_SUPPLY) * 100;
      return top10Pct; } });
    this._fCache = { bucket, f };
    return f;
  }

  /** Sum of the n largest holder balances (partial selection, no full sort). */
  topHolders(n) {
    const top = [];
    for (const v of this.holders.values()) {
      if (top.length < n) { top.push(v); if (top.length === n) top.sort((a, b) => a - b); }
      else if (v > top[0]) { top[0] = v; for (let i = 0; i < n - 1 && top[i] > top[i + 1]; i++) [top[i], top[i + 1]] = [top[i + 1], top[i]]; }
    }
    return top.reduce((a, b) => a + b, 0);
  }

  /** Compact row for the UI feed. */
  toRow(now) {
    const f = this.features(now);
    const spark = [];
    const step = Math.max(1, Math.floor(this.trades.length / 24));
    for (let i = 0; i < this.trades.length; i += step) spark.push(+(this.trades[i].price * 1e9).toFixed(3));
    if (this.trades.length) spark.push(+(this.price * 1e9).toFixed(3));
    return {
      mint: this.mint, name: this.name, symbol: this.symbol, image: this.image, creator: this.creator,
      age: f.ageSec, mcap: f.mcapSol, buyers: f.uniqueBuyers, holders: f.holders, buys: f.buys, sells: f.sells,
      buyVol: f.buyVolSol, sellVol: f.sellVolSol, vel10: f.vel10, devPct: f.devHoldPct, devSold: f.devSoldPct,
      bundlePct: f.bundlePct, top10: f.top10Pct, progress: f.progressPct, gap: f.tradeGapSec,
      whale: f.bigBuys30.reduce((a, b) => a + b, 0), socials: f.hasSocials, migrated: this.migrated, spark,
    };
  }
}
