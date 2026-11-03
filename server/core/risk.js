// Hard-coded guardrails. Agents (including LLM agents) can PROPOSE anything, but nothing
// trades unless it passes these checks. These limits are frozen and not editable at runtime.

export const HARD_LIMITS = Object.freeze({
  maxRiskPerTradePct: 2,       // never put more than 2% of equity into one trade
  maxPositionSol: 2,           // absolute cap per trade regardless of equity
  maxOpenPositions: 6,         // portfolio-wide
  maxPerMint: 2,               // max strategies holding the same coin
  maxExposurePct: 12,          // total open cost as % of equity
  maxStopLossPct: 35,          // every strategy MUST have a stop at or below this
  maxDailyDrawdownPct: 10,     // halt new entries for the rest of the day
  maxTotalDrawdownPct: 25,     // kill switch: no new entries until manual reset
  lossStreakPause: 4,          // consecutive losses -> cooldown
  lossStreakCooldownSec: 300,
  minCashReservePct: 50,       // always keep at least half the account in SOL
  maxSlippagePct: 20,          // reject fills worse than this vs signal price
});

export class RiskManager {
  constructor(startEquity, limits = HARD_LIMITS) {
    this.L = limits;
    this.peakEquity = startEquity;
    this.dayStartEquity = startEquity;
    this.day = null;
    this.consecutiveLosses = 0;
    this.pausedUntil = 0;
    this.killed = false;
    this.haltedToday = false;
    this.lastReason = '';
  }

  onEquity(equity, now) {
    const day = Math.floor(now / 86_400_000);
    if (day !== this.day) { this.day = day; this.dayStartEquity = equity; this.haltedToday = false; }
    if (equity > this.peakEquity) this.peakEquity = equity;
    const totalDD = (1 - equity / this.peakEquity) * 100;
    const dayDD = (1 - equity / this.dayStartEquity) * 100;
    if (!this.killed && totalDD >= this.L.maxTotalDrawdownPct) { this.killed = true; return { event: 'kill', totalDD }; }
    if (!this.haltedToday && dayDD >= this.L.maxDailyDrawdownPct) { this.haltedToday = true; return { event: 'halt', dayDD }; }
    return null;
  }

  onClose(pnlSol, now) {
    if (pnlSol < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.L.lossStreakPause) {
        this.pausedUntil = now + this.L.lossStreakCooldownSec * 1000;
        this.consecutiveLosses = 0;
        return { event: 'cooldown', until: this.pausedUntil };
      }
    } else this.consecutiveLosses = 0;
    return null;
  }

  /** Approve and size a buy. Returns {ok, sizeSol, reason}. */
  approve({ params, equity, cash, openPositions, openCost, mintHolders, now }) {
    const L = this.L;
    if (this.killed) return { ok: false, reason: 'kill switch (max drawdown) engaged' };
    if (this.haltedToday) return { ok: false, reason: 'daily drawdown halt' };
    if (now < this.pausedUntil) return { ok: false, reason: 'loss-streak cooldown' };
    if (!(params.stopLossPct > 0 && params.stopLossPct <= L.maxStopLossPct)) return { ok: false, reason: 'strategy has no valid stop-loss' };
    if (openPositions >= L.maxOpenPositions) return { ok: false, reason: 'max open positions' };
    if (mintHolders >= L.maxPerMint) return { ok: false, reason: 'max strategies per coin' };
    const pct = Math.min(params.sizePct, L.maxRiskPerTradePct);
    const sizeSol = Math.min(equity * pct / 100, L.maxPositionSol);
    if (sizeSol < 0.005) return { ok: false, reason: 'size too small' };
    if ((openCost + sizeSol) / equity * 100 > L.maxExposurePct) return { ok: false, reason: 'max exposure' };
    if ((cash - sizeSol) / equity * 100 < L.minCashReservePct) return { ok: false, reason: 'cash reserve' };
    return { ok: true, sizeSol };
  }

  status() {
    return { killed: this.killed, haltedToday: this.haltedToday, pausedUntil: this.pausedUntil,
      consecutiveLosses: this.consecutiveLosses, peakEquity: this.peakEquity, dayStartEquity: this.dayStartEquity };
  }

  reset(equity) { Object.assign(this, new RiskManager(equity, this.L)); }
}
