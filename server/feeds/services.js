// Side services for live mode: token metadata (socials/image) and SOL/USD price.
import { EventEmitter } from 'node:events';

const timeoutFetch = async (url, ms = 3000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
  finally { clearTimeout(t); }
};

const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
const gw = (u) => (u?.startsWith('ipfs://') ? IPFS_GATEWAY + u.slice(7) : u);

/** Fetches the Pump.fun metadata JSON (twitter/telegram/website/image) with bounded concurrency. */
export class MetadataFetcher extends EventEmitter {
  constructor({ concurrency = 6, maxQueue = 60 } = {}) { super(); this.q = []; this.active = 0; this.concurrency = concurrency; this.maxQueue = maxQueue; }
  push(mint, uri) {
    if (!uri) return;
    if (this.q.length >= this.maxQueue) this.q.shift(); // newest coins matter most
    this.q.push({ mint, uri }); this.pump();
  }
  pump() {
    while (this.active < this.concurrency && this.q.length) {
      const { mint, uri } = this.q.pop();
      this.active++;
      timeoutFetch(gw(uri)).then((j) => {
        const socials = { twitter: j.twitter || null, telegram: j.telegram || null, website: j.website || null };
        this.emit('event', { type: 'meta', ts: Date.now(), mint, socials, image: gw(j.image) || null });
      }).catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  }
}

export class SolPrice {
  constructor() { this.usd = 160; this.ts = 0; this.source = 'default'; }
  start() { this.refresh(); this.timer = setInterval(() => this.refresh(), 60_000); this.timer.unref(); }
  async refresh() {
    const sources = [
      ['jupiter', 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', (j) => j?.So11111111111111111111111111111111111111112?.usdPrice],
      ['coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', (j) => j?.solana?.usd],
    ];
    for (const [name, url, pick] of sources) {
      try { const v = +pick(await timeoutFetch(url, 4000)); if (v > 0) { this.usd = v; this.ts = Date.now(); this.source = name; return; } } catch { /* try next */ }
    }
  }
}
