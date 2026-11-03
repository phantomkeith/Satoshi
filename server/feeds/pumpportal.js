// PumpPortal real-time websocket (wss://pumpportal.fun/api/data): new-token, per-token trade
// and migration streams for Pump.fun. One connection, dynamic per-mint trade subscriptions.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { proxyAgent } from './proxy.js';

export class PumpPortalFeed extends EventEmitter {
  constructor({ url = 'wss://pumpportal.fun/api/data', maxTracked = 1500 } = {}) {
    super();
    this.url = url;
    this.maxTracked = maxTracked;
    this.tracked = new Set();
    this.toSub = new Set();
    this.toUnsub = new Set();
    this.backoff = 1000;
    this.name = 'PumpPortal websocket';
    this.stats = { msgs: 0, creates: 0, trades: 0, reconnects: 0 };
  }

  start() {
    this.stopped = false;
    this.connect();
    this.flushTimer = setInterval(() => this.flush(), 150);
  }

  connect() {
    const ws = new WebSocket(this.url, { agent: proxyAgent(this.url), perMessageDeflate: false, handshakeTimeout: 10000 });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      if (this.tracked.size) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.tracked] }));
      this.emit('status', { connected: true, source: this.name });
    });
    ws.on('message', (buf) => {
      const ts = Date.now();
      let m;
      try { m = JSON.parse(buf); } catch { return; }
      this.stats.msgs++;
      if (!m || m.message || !m.mint) return; // subscription acks
      if (m.txType === 'create') {
        this.stats.creates++;
        this.emit('event', {
          type: 'create', ts, mint: m.mint, name: m.name, symbol: m.symbol, uri: m.uri, creator: m.traderPublicKey,
          vSol: +m.vSolInBondingCurve, vTok: +m.vTokensInBondingCurve, initialBuyTokens: +m.initialBuy || 0,
          initialBuySol: +m.solAmount || 0, sig: m.signature, pool: m.pool,
        });
        this.track(m.mint);
      } else if (m.txType === 'buy' || m.txType === 'sell') {
        if (!this.tracked.has(m.mint)) return;
        this.stats.trades++;
        this.emit('event', {
          type: 'trade', ts, mint: m.mint, trader: m.traderPublicKey, side: m.txType, sol: +m.solAmount, tokens: +m.tokenAmount,
          vSol: m.vSolInBondingCurve != null ? +m.vSolInBondingCurve : undefined,
          vTok: m.vTokensInBondingCurve != null ? +m.vTokensInBondingCurve : undefined, sig: m.signature,
        });
      } else if (m.txType === 'migrate' || m.pool === 'pump-amm') {
        this.emit('event', { type: 'migrate', ts, mint: m.mint });
      }
    });
    ws.on('close', () => this.reconnect());
    ws.on('error', (e) => { this.emit('status', { connected: false, source: this.name, error: e.message }); });
  }

  reconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    this.emit('status', { connected: false, source: this.name, error: 'reconnecting' });
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  track(mint) {
    if (this.tracked.has(mint)) return;
    this.tracked.add(mint); this.toSub.add(mint);
    if (this.tracked.size > this.maxTracked) this.untrack([this.tracked.values().next().value]);
  }

  untrack(mints) {
    for (const m of mints) { if (this.tracked.delete(m)) { this.toUnsub.add(m); this.toSub.delete(m); } }
  }

  flush() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.toSub.size) { this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.toSub] })); this.toSub.clear(); }
    if (this.toUnsub.size) { this.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [...this.toUnsub] })); this.toUnsub.clear(); }
  }

  stop() { this.stopped = true; clearInterval(this.flushTimer); this.ws?.close(); }
}
