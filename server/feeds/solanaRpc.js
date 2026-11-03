// Direct on-chain detection: subscribes to Solana RPC logs that mention the Pump.fun program
// and decodes its Anchor events (CreateEvent / TradeEvent / CompleteEvent) straight from the
// "Program data:" log lines. No third-party API in the path — use a low-latency RPC (Helius,
// Triton, QuickNode, a private node) with commitment "processed" for the fastest signal.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { base58Encode } from '../util/base58.js';
import { proxyAgent } from './proxy.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const disc = (name) => crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const D_CREATE = disc('CreateEvent');
const D_TRADE = disc('TradeEvent');
const D_COMPLETE = disc('CompleteEvent');

class Reader {
  constructor(buf) { this.b = buf; this.o = 8; }
  left() { return this.b.length - this.o; }
  str() { const n = this.b.readUInt32LE(this.o); this.o += 4; const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  pk() { const k = base58Encode(this.b.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return Number(v); }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return Number(v); }
  bool() { return this.b[this.o++] === 1; }
}

export function decodePumpEvent(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 8) return null;
  const d = buf.subarray(0, 8).toString('hex');
  const r = new Reader(buf);
  try {
    if (d === D_CREATE) {
      const name = r.str(), symbol = r.str(), uri = r.str(), mint = r.pk(), bondingCurve = r.pk(), user = r.pk();
      const creator = r.left() >= 32 + 8 ? r.pk() : user;
      const timestamp = r.left() >= 8 ? r.i64() : 0;
      const vTok = r.left() >= 8 ? r.u64() / 1e6 : 1_073_000_000;
      const vSol = r.left() >= 8 ? r.u64() / 1e9 : 30;
      return { kind: 'create', name, symbol, uri, mint, bondingCurve, user, creator, timestamp, vTok, vSol };
    }
    if (d === D_TRADE) {
      const mint = r.pk(), sol = r.u64() / 1e9, tokens = r.u64() / 1e6, isBuy = r.bool(), user = r.pk(), timestamp = r.i64();
      const vSol = r.u64() / 1e9, vTok = r.u64() / 1e6;
      return { kind: 'trade', mint, sol, tokens, isBuy, user, timestamp, vSol, vTok };
    }
    if (d === D_COMPLETE) { const user = r.pk(), mint = r.pk(); return { kind: 'complete', user, mint }; }
  } catch { return null; }
  return null;
}

export class SolanaRpcFeed extends EventEmitter {
  constructor({ wsUrl, commitment = 'processed' }) {
    super();
    if (!wsUrl) throw new Error('SOLANA_WS_URL is required for FEED_MODE=rpc');
    this.wsUrl = wsUrl; this.commitment = commitment;
    this.known = new Set();
    this.backoff = 1000;
    this.name = 'Solana RPC logsSubscribe (direct)';
    this.stats = { msgs: 0, creates: 0, trades: 0, reconnects: 0 };
  }

  start() { this.stopped = false; this.connect(); }

  connect() {
    const ws = new WebSocket(this.wsUrl, { agent: proxyAgent(this.wsUrl), perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: this.commitment }] }));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 20000);
      this.emit('status', { connected: true, source: this.name });
    });
    ws.on('message', (buf) => {
      const ts = Date.now();
      let m; try { m = JSON.parse(buf); } catch { return; }
      const v = m?.params?.result?.value;
      if (!v || v.err) return;
      this.stats.msgs++;
      const slot = m.params.result.context?.slot;
      for (const line of v.logs || []) {
        if (!line.startsWith('Program data: ')) continue;
        const ev = decodePumpEvent(line.slice(14));
        if (!ev) continue;
        if (ev.kind === 'create') {
          this.stats.creates++;
          this.known.add(ev.mint);
          if (this.known.size > 20000) this.known = new Set([...this.known].slice(-10000));
          this.emit('event', { type: 'create', ts, slot, mint: ev.mint, name: ev.name, symbol: ev.symbol, uri: ev.uri, creator: ev.creator,
            vSol: ev.vSol, vTok: ev.vTok, initialBuyTokens: 0, initialBuySol: 0, sig: v.signature });
        } else if (ev.kind === 'trade' && this.known.has(ev.mint)) {
          this.stats.trades++;
          this.emit('event', { type: 'trade', ts, slot, mint: ev.mint, trader: ev.user, side: ev.isBuy ? 'buy' : 'sell', sol: ev.sol,
            tokens: ev.tokens, vSol: ev.vSol, vTok: ev.vTok, sig: v.signature });
        } else if (ev.kind === 'complete' && this.known.has(ev.mint)) {
          this.emit('event', { type: 'migrate', ts, slot, mint: ev.mint });
        }
      }
    });
    ws.on('close', () => { clearInterval(this.ping); this.reconnect(); });
    ws.on('error', (e) => this.emit('status', { connected: false, source: this.name, error: e.message }));
  }

  reconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  untrack(mints) { for (const m of mints) this.known.delete(m); }
  stop() { this.stopped = true; clearInterval(this.ping); this.ws?.close(); }
}
