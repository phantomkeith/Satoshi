// Synthetic Pump.fun market. Produces the SAME normalized events as the live feeds, with
// realistic archetypes (dead coins, dev rugs, bundled launches, pump & dumps, whale-backed
// runners, slow bleeds) so the team can be tested and trained offline.
import { EventEmitter } from 'node:events';
import { Rng } from '../util/rng.js';
import { randomBase58 } from '../util/base58.js';
import { INITIAL_VSOL, INITIAL_VTOK, GRADUATION_VSOL, applyBuy, applySell } from '../core/curve.js';

export const ARCHETYPES = [
  ['dead', 0.44], ['rug_dev', 0.12], ['bundle_rug', 0.09], ['pump_dump', 0.14], ['fader', 0.10], ['runner', 0.05], ['slow_bleed', 0.06],
];

const A = ['Based', 'Moon', 'Giga', 'Turbo', 'Smol', 'Wif', 'Doge', 'Pepe', 'Chad', 'Sigma', 'Baby', 'Dark', 'Cyber', 'Grok', 'Pixel', 'Fat', 'Lil', 'Mega', 'Zen', 'Hyper'];
const B = ['Cat', 'Frog', 'Inu', 'Hat', 'Bonk', 'Ape', 'Goat', 'Penguin', 'Dragon', 'Bean', 'Rocket', 'Coin', 'Duck', 'Hamster', 'Wizard', 'Shiba', 'Otter', 'Bull', 'Capy', 'Fish'];

function phaseFor(arch, age, s) {
  switch (arch) {
    case 'dead': return { lam: 1.4 * Math.exp(-age / 7), pBuy: 0.55, mu: Math.log(0.25), sig: 0.8, pNew: 0.85, whale: 0 };
    case 'slow_bleed': return { lam: 0.9, pBuy: 0.44, mu: Math.log(0.3), sig: 0.8, pNew: 0.6, whale: 0.005 };
    case 'runner': {
      const r = age / s.life;
      if (r > s.peakAt) return { lam: 1.2, pBuy: 0.4, mu: Math.log(0.3), sig: 0.9, pNew: 0.3, whale: 0.005 };
      return { lam: 1.0 + 1.6 * Math.min(age / 90, 1), pBuy: age < 30 ? 0.62 : 0.58, mu: Math.log(s.strength), sig: 1.0, pNew: 0.8, whale: age < 20 ? 0.015 : 0.04 };
    }
    case 'fader': // fake momentum: looks like a whale-backed runner, then distribution
      if (age < s.fadeAt) return { lam: 1.2 + 1.6 * Math.min(age / 40, 1), pBuy: 0.53, mu: Math.log(0.3), sig: 1.0, pNew: 0.8, whale: 0.045 };
      if (age < s.fadeAt + 40) return { lam: 2.5, pBuy: 0.3, mu: Math.log(0.25), sig: 0.8, pNew: 0.3, whale: 0.01, dump: true };
      return { lam: 0.4, pBuy: 0.4, mu: Math.log(0.15), sig: 0.6, pNew: 0.6, whale: 0 };
    case 'pump_dump':
      if (age < s.pumpEnd) return { lam: 3, pBuy: 0.66, mu: Math.log(0.35), sig: 0.7, pNew: 0.3, whale: 0.03 };
      if (age < s.pumpEnd + 18) return { lam: 4, pBuy: 0.12, mu: Math.log(0.3), sig: 0.6, pNew: 0.1, whale: 0, dump: true };
      return { lam: 0.3, pBuy: 0.4, mu: Math.log(0.15), sig: 0.6, pNew: 0.8, whale: 0 };
    case 'rug_dev':
      if (age < s.rugAt) return { lam: 1.8, pBuy: 0.5, mu: Math.log(0.3), sig: 0.8, pNew: 0.75, whale: 0.025 };
      if (age < s.rugAt + 15) return { lam: 3, pBuy: 0.15, mu: Math.log(0.2), sig: 0.6, pNew: 0.2, whale: 0, dump: true };
      return { lam: 0.25, pBuy: 0.4, mu: Math.log(0.1), sig: 0.5, pNew: 0.8, whale: 0 };
    case 'bundle_rug':
      if (age < s.rugAt) return { lam: 1.6, pBuy: 0.5, mu: Math.log(0.3), sig: 0.8, pNew: 0.75, whale: 0.02 };
      if (age < s.rugAt + 15) return { lam: 3, pBuy: 0.15, mu: Math.log(0.2), sig: 0.6, pNew: 0.2, whale: 0, dump: true };
      return { lam: 0.25, pBuy: 0.4, mu: Math.log(0.1), sig: 0.5, pNew: 0.8, whale: 0 };
  }
  return { lam: 0 };
}

export function generateToken(rng, t0, ctx) {
  const arch = rng.weighted(ARCHETYPES);
  const wallet = () => randomBase58(rng, 32);
  const isRug = arch === 'rug_dev' || arch === 'bundle_rug';
  const creator = isRug && rng.chance(0.5) ? rng.pick(ctx.ruggers) : wallet();
  const mint = randomBase58(rng, 40) + 'pump';
  const a = rng.pick(A), b = rng.pick(B);
  const name = `${a} ${b}`;
  const symbol = (a.slice(0, 2) + b.slice(0, rng.int(2, 4))).toUpperCase();
  const s = {
    life: arch === 'dead' ? rng.range(20, 90) : arch === 'runner' ? rng.range(240, 900) : arch === 'slow_bleed' ? rng.range(120, 300) : 400,
    pumpEnd: rng.range(10, 35), rugAt: rng.range(25, 180),
    peakAt: rng.range(0.25, 0.8), fadeAt: rng.range(30, 150), strength: rng.range(0.05, 0.22),
  };
  if (arch === 'pump_dump') s.life = s.pumpEnd + 60;
  if (isRug) s.life = s.rugAt + 50;
  if (arch === 'fader') s.life = s.fadeAt + 90;

  let devSol = arch === 'rug_dev' ? rng.range(1.5, 4) : arch === 'dead' ? rng.range(0, 1.2) : rng.range(0.2, 1.5);
  if (arch === 'runner' && rng.chance(0.1)) devSol = rng.range(2, 3); // noise: some good devs buy big
  const socialP = arch === 'runner' || arch === 'fader' ? 0.75 : arch === 'dead' ? 0.3 : 0.5;
  const hasSoc = rng.chance(socialP);
  const socials = hasSoc ? { twitter: `https://x.com/${symbol.toLowerCase()}`, telegram: rng.chance(0.5) ? `https://t.me/${symbol.toLowerCase()}` : null, website: null } : { twitter: null, telegram: null, website: null };

  let vSol = INITIAL_VSOL, vTok = INITIAL_VTOK;
  const holders = new Map();
  const events = [];
  const createSlot = Math.floor(t0 / 400);
  let devTokens = 0;
  if (devSol > 0) { const r = applyBuy(vSol, vTok, devSol); vSol = r.vSol; vTok = r.vTok; devTokens = r.tokens; holders.set(creator, devTokens); }
  events.push({ type: 'create', ts: t0, slot: createSlot, mint, name, symbol, uri: '', creator, vSol, vTok, initialBuyTokens: devTokens, initialBuySol: devSol, socials, _arch: arch });

  let done = false;
  const buy = (ts, trader, sol, slot) => {
    const r = applyBuy(vSol, vTok, sol); vSol = r.vSol; vTok = r.vTok;
    holders.set(trader, (holders.get(trader) || 0) + r.tokens);
    events.push({ type: 'trade', ts: Math.round(ts), slot: slot ?? Math.floor(ts / 400), mint, trader, side: 'buy', sol, tokens: r.tokens, vSol, vTok });
    if (vSol >= GRADUATION_VSOL) { events.push({ type: 'migrate', ts: Math.round(ts) + 400, mint }); done = true; }
  };
  const sell = (ts, trader, tokens) => {
    const held = holders.get(trader) || 0;
    tokens = Math.min(tokens, held);
    if (tokens <= 1) return;
    const r = applySell(vSol, vTok, tokens); vSol = r.vSol; vTok = r.vTok;
    if (held - tokens > 1) holders.set(trader, held - tokens); else holders.delete(trader);
    events.push({ type: 'trade', ts: Math.round(ts), slot: Math.floor(ts / 400), mint, trader, side: 'sell', sol: r.sol, tokens, vSol, vTok });
  };

  // Bundled launch: coordinated wallets buying in the creation slot.
  const bundlers = [];
  const nBundle = arch === 'bundle_rug' ? rng.int(4, 10) : rng.chance(0.15) ? rng.int(1, 2) : 0;
  for (let i = 0; i < nBundle; i++) {
    const w = wallet(); bundlers.push(w);
    buy(t0 + rng.range(20, 350), w, rng.range(0.4, 2.5), createSlot);
  }

  // Competing sniper bots: buy in the first seconds, dump into later buyers.
  const snipers = [];
  const botSet = new Set();
  const nSnipers = rng.int(1, 6);
  for (let i = 0; i < nSnipers; i++) {
    const w = wallet(); botSet.add(w); snipers.push({ w, sellAt: t0 + rng.range(4, 45) * 1000 });
    buy(t0 + rng.range(400, 2500), w, rng.range(0.3, 2));
  }
  events.sort((x, y) => x.ts - y.ts);

  const pool = Array.from({ length: 8 }, wallet); // pump & dump wash wallets
  let t = t0 + rng.range(400, 1500);
  let devDumped = false, bundleDumped = false, devTrimmed = false;
  const trimAt = arch === 'runner' && rng.chance(0.15) ? rng.range(40, 200) : Infinity;
  const traders = () => [...holders.keys()].filter((w) => w !== creator && !bundlers.includes(w) && !botSet.has(w));

  while (!done) {
    const age = (t - t0) / 1000;
    if (age > s.life) break;
    if (isRug && !devDumped && age >= s.rugAt) {
      devDumped = true;
      if (arch === 'rug_dev') sell(t, creator, holders.get(creator) || 0);
      else { let k = 0; for (const w of bundlers) sell(t + (k++) * rng.range(50, 600), w, holders.get(w) || 0); bundleDumped = true; }
      if (arch === 'bundle_rug' && rng.chance(0.5)) sell(t + 900, creator, holders.get(creator) || 0);
    }
    for (const sn of snipers) if (!sn.sold && t >= sn.sellAt) { sn.sold = true; sell(t, sn.w, holders.get(sn.w) || 0); }
    if (!devTrimmed && age >= trimAt) { devTrimmed = true; sell(t, creator, (holders.get(creator) || 0) * 0.2); }
    const ph = phaseFor(arch, age, s);
    if (!(ph.lam > 0.02)) break;
    t += rng.exp(ph.lam) * 1000;
    if (rng.chance(ph.pBuy)) {
      let sol = Math.min(15, Math.max(0.01, rng.logn(ph.mu, ph.sig)));
      if (rng.chance(ph.whale)) sol = rng.range(2, 9);
      const tr = traders();
      const trader = arch === 'pump_dump' && age < s.pumpEnd && !rng.chance(ph.pNew) ? rng.pick(pool)
        : (rng.chance(ph.pNew) || !tr.length) ? wallet() : rng.pick(tr);
      buy(t, trader, sol);
    } else {
      const tr = traders();
      if (!tr.length) continue;
      const w = rng.pick(tr);
      sell(t, w, (holders.get(w) || 0) * (ph.dump ? rng.range(0.7, 1) : rng.range(0.5, 1)));
    }
  }
  return events;
}

/** Generate a full, time-sorted event tape (for backtests / training). */
export function generateTape({ seed = 1, durationSec = 3600, launchesPerMin = 12, startTs = 1_700_000_000_000 } = {}) {
  const rng = new Rng(seed);
  const ctx = { ruggers: Array.from({ length: 25 }, () => randomBase58(rng, 32)) };
  const all = [];
  let t = startTs;
  const end = startTs + durationSec * 1000;
  while (t < end) {
    t += rng.exp(launchesPerMin / 60) * 1000;
    for (const e of generateToken(rng, Math.round(t), ctx)) all.push(e);
  }
  all.sort((x, y) => x.ts - y.ts);
  return all.filter((e) => e.ts <= end);
}

/** Real-time simulated feed: emits normalized events on wall-clock time. */
export class SimFeed extends EventEmitter {
  constructor({ seed = Date.now() % 1e9, launchesPerMin = 14 } = {}) {
    super();
    this.rng = new Rng(seed);
    this.ctx = { ruggers: Array.from({ length: 25 }, () => randomBase58(this.rng, 32)) };
    this.launchesPerMin = launchesPerMin;
    this.queue = [];
    this.name = 'SIM · synthetic pump.fun market';
  }
  start() {
    const schedule = () => {
      const delay = this.rng.exp(this.launchesPerMin / 60) * 1000;
      this.launchTimer = setTimeout(() => {
        for (const e of generateToken(this.rng, Date.now(), this.ctx)) this.queue.push(e);
        this.queue.sort((a, b) => a.ts - b.ts);
        schedule();
      }, delay);
    };
    schedule();
    this.pump = setInterval(() => {
      const now = Date.now();
      let i = 0;
      while (i < this.queue.length && this.queue[i].ts <= now) { const { _arch, ...e } = this.queue[i++]; this.emit('event', e); }
      if (i) this.queue.splice(0, i);
    }, 50);
    this.emit('status', { connected: true, source: this.name });
  }
  stop() { clearTimeout(this.launchTimer); clearInterval(this.pump); }
  untrack() {}
}
