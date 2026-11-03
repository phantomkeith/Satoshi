// GrokDesk: the AI trading team. Wires the market engine to the agents and runs the
// self-learning loop:  detect -> filter -> score -> risk -> execute (paper) -> autopsy
// -> rewrite -> backtest -> stress test -> promote/retire -> repeat.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from './core/engine.js';
import { SEED_STRATEGIES, makeStrategy, diffParams, normalizeParams, scoreToken } from './core/strategy.js';
import { HARD_LIMITS } from './core/risk.js';
import { autopsy, reviewWin } from './agents/critic.js';
import { Strategist } from './agents/strategist.js';
import { Rng } from './util/rng.js';
import { short } from './util/base58.js';

export const AGENTS = {
  scout:      { name: 'Scout',      role: 'On-chain detection',      color: '#38bdf8' },
  sentinel:   { name: 'Sentinel',   role: 'Rug / bundle / dev filters', color: '#f59e0b' },
  quant:      { name: 'Quant',      role: 'Scoring & signals',       color: '#a78bfa' },
  risk:       { name: 'Risk',       role: 'Hard guardrails & sizing', color: '#f43f5e' },
  exec:       { name: 'Exec',       role: 'Jito/priority execution',  color: '#22c55e' },
  critic:     { name: 'Critic',     role: 'Loss autopsies',          color: '#fb7185' },
  strategist: { name: 'Strategist', role: 'Rewrite, backtest, promote', color: '#eab308' },
  researcher: { name: 'Researcher', role: 'New strategy research',   color: '#2dd4bf' },
};

const REASON_TEXT = {
  dev_bag: 'dev bag too big', dev_selling: 'dev already selling', bundled: 'bundled supply', concentrated: 'top-10 too concentrated',
  no_socials: 'no socials', serial_rugger: 'serial rugger creator',
};

const fmtSol = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;
const fmtPct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);

export class Desk extends EventEmitter {
  constructor({ config, memory, llm, backtests, clock = 'live', seed = Date.now() % 1e9 }) {
    super();
    this.cfg = config;
    this.memory = memory;
    this.llm = llm;
    this.backtests = backtests;
    this.clock = clock;
    this.rng = new Rng(seed);
    this.startingSol = config.startingSol;

    const saved = (memory.data.strategies || []).filter((s) => s.active);
    const strategies = saved.length ? saved.map((s) => ({ ...s, params: normalizeParams(s.params) })) : SEED_STRATEGIES.map(makeStrategy);
    this.engine = new Engine({ strategies, startingSol: this.startingSol, exec: config.exec, seed, fixedSizing: !!config.fixedSizing,
      emit: (k, d) => this.onEngine(k, d), creatorRugs: (c) => memory.creatorRugs(c) });
    this.allStrategies = new Map(strategies.map((s) => [s.id, s]));
    for (const s of memory.data.strategies || []) if (!this.allStrategies.has(s.id)) this.allStrategies.set(s.id, s);
    this.restorePortfolio();

    this.strategist = new Strategist({ rng: this.rng, backtests, llm, memory, startingSol: this.startingSol });
    this.agents = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, { ...v, id: k, status: 'idle', last: '', count: 0, ts: 0 }]));
    this.messages = [];
    this.tape = [];
    this.coinOrder = [];
    this.pendingAutopsy = [];
    this.lossBuckets = new Map();
    this.blockSeen = new Set();
    this.throttle = new Map();
    this.counters = { launches: 0, launchesWindow: 0, aliveWindow: 0, blocked: {}, signals: 0, fills: 0, fails: 0 };
    this.learn = { busy: false, cycles: 0, patches: 0, promotions: 0, rejections: 0, retired: 0, adopted: 0, lastMs: 0, last: '' };
    this.nextEvolveTs = 0;
    this.lastScoutTs = 0;
    this.paused = false;
    this.backtestScores = new Map();
    this.lastPatch = new Map();
    if (config.recordTape) this.openTape();
  }

  // ---------------------------------------------------------------- persistence
  restorePortfolio() {
    const p = this.memory.data.portfolio;
    if (!p) return;
    this.engine.cash = p.cash;
    this.engine.closed = p.closed || [];
    this.engine.equityHist = p.equityHist || [];
    for (const [id, st] of Object.entries(p.stats || {})) if (this.engine.stats.has(id) || this.allStrategies.has(id)) this.engine.stats.set(id, st);
    this.engine.risk.peakEquity = Math.max(p.peakEquity || p.cash, p.cash);
    this.startingSol = p.startingSol || this.startingSol;
    this.engine.startingSol = this.startingSol;
  }

  persist() {
    const e = this.engine;
    this.memory.data.portfolio = {
      cash: e.equity(), startingSol: this.startingSol, peakEquity: e.risk.peakEquity,
      closed: e.closed.slice(-300), equityHist: e.equityHist.slice(-5000), stats: Object.fromEntries(e.stats),
    };
    this.memory.data.strategies = [...this.allStrategies.values()].sort((a, b) => (b.active - a.active) || (b.createdAt - a.createdAt)).slice(0, 60);
    this.memory.dirty = true;
    this.memory.save();
  }

  openTape() {
    const dir = path.join(this.cfg.dataDir, 'tape');  // per-mode data dir (sim / live)
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    // Warm start: load the tail of today's tape so the Strategist can backtest immediately.
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, 40 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      lines.shift();
      for (const l of lines) if (l) { try { this.tape.push(JSON.parse(l)); } catch { /* partial line */ } }
      if (this.tape.length > this.cfg.tapeMax) this.tape.splice(0, this.tape.length - this.cfg.tapeMax);
    } catch { /* no tape yet */ }
    this.tapeStream = fs.createWriteStream(file, { flags: 'a' });
  }

  // ---------------------------------------------------------------- chat
  say(agent, text, level = 'info', extra = {}) {
    const a = this.agents[agent];
    const msg = { id: this.messages.length ? this.messages[this.messages.length - 1].id + 1 : 1, ts: this.engine.now || Date.now(), agent, text, level, ...extra };
    a.last = text; a.ts = msg.ts; a.count++; a.status = level === 'alert' ? 'alert' : 'working';
    this.messages.push(msg);
    if (this.messages.length > 400) this.messages.splice(0, 100);
    this.emit('message', msg);
    return msg;
  }

  throttled(key, ms) {
    const now = this.engine.now;
    const last = this.throttle.get(key) || -Infinity;
    if (now - last < ms) return false;
    this.throttle.set(key, now);
    return true;
  }

  // ---------------------------------------------------------------- engine events
  onEngine(kind, d) {
    switch (kind) {
      case 'create': {
        this.counters.launches++; this.counters.launchesWindow++;
        this.coinOrder.unshift(d.mint);
        if (this.coinOrder.length > 400) this.coinOrder.length = 300;
        this.agents.scout.last = `Detected $${d.symbol} (${short(d.mint)}) by ${short(d.creator)}`;
        this.agents.scout.status = 'working'; this.agents.scout.ts = d.createdTs;
        const rugs = this.memory.creatorRugs(d.creator);
        if (rugs > 0 && this.throttled('rugger', 8000)) this.say('sentinel', `Serial rugger ${short(d.creator)} just launched $${d.symbol} (${rugs} prior rug${rugs > 1 ? 's' : ''} in memory). Blacklisted.`, 'warn', { mint: d.mint });
        this.emit('create', d);
        break;
      }
      case 'blocked': {
        const { token: t, strategy: s, r } = d;
        for (const x of r.safetyFails) this.counters.blocked[x] = (this.counters.blocked[x] || 0) + 1;
        const key = t.mint;
        if (this.blockSeen.has(key)) break;
        this.blockSeen.add(key);
        if (this.blockSeen.size > 3000) this.blockSeen.clear();
        if (!this.throttled('blocked', 4000)) break;
        const f = t.features(this.engine.now);
        const detail = r.safetyFails.map((x) => x === 'bundled' ? `bundled ${f.bundlePct.toFixed(1)}% in ${f.bundleWallets} wallet${f.bundleWallets === 1 ? "" : "s"}`
          : x === 'dev_bag' ? `dev holds ${f.devHoldPct.toFixed(1)}%` : x === 'concentrated' ? `top-10 hold ${f.top10Pct.toFixed(0)}%`
          : x === 'dev_selling' ? `dev sold ${(f.devSoldPct * 100).toFixed(0)}% of bag` : REASON_TEXT[x] || x).join(', ');
        this.say('sentinel', `Blocked $${t.symbol} for ${s.name}: ${detail}. Momentum looked fine — not worth the rug risk.`, 'warn', { mint: t.mint });
        break;
      }
      case 'signal': {
        const { order: o, token: t, strategy: s, r } = d;
        this.counters.signals++;
        const f = o.features;
        this.say('quant', `$${t.symbol} scores ${r.score}/100 — ${f.uniqueBuyers} buyers, ${f.vel10} tx/10s, B/S ${f.bsRatio.toFixed(1)}, whales ${r.whale.toFixed(1)} SOL, dev ${f.devHoldPct.toFixed(1)}%. ${s.name} wants in.`, 'info', { mint: t.mint });
        this.say('risk', `Approved ${o.sizeSol.toFixed(3)} SOL on $${t.symbol} (${(o.sizeSol / this.engine.equity() * 100).toFixed(2)}% of equity, stop −${s.params.stopLossPct}%).`, 'info', { mint: t.mint });
        break;
      }
      case 'riskReject':
        if (this.throttled('reject:' + d.reason, 15000)) this.say('risk', `Vetoed ${d.strategy.name} on $${d.token.symbol}: ${d.reason}.`, 'warn', { mint: d.token.mint });
        break;
      case 'open': {
        this.counters.fills++;
        const { pos, token: t } = d;
        this.say('exec', `BUY $${t.symbol} ${(pos.costSol).toFixed(3)} SOL @ ${t.mcap.toFixed(1)} SOL mcap · slip ${fmtPct(pos.slipPct)} · ${this.engine.exec.latencyMs}ms · ${pos.strategyName}`, 'buy', { mint: t.mint });
        this.emit('trade', { side: 'buy', pos });
        break;
      }
      case 'fail':
        this.counters.fails++;
        if (this.throttled('fail', 5000)) this.say('exec', `Missed $${d.token.symbol}: ${d.reason}. No position, priority fee burned.`, 'warn', { mint: d.token.mint });
        break;
      case 'partial':
        if (d.pos.tokensLeft > 0) this.say('exec', `Took profit on ${(d.pos.exits.at(-1).fraction * 100).toFixed(0)}% of $${d.token.symbol} (+${d.sol.toFixed(3)} SOL). Letting the rest ride with trailing stop.`, 'sell', { mint: d.token.mint });
        break;
      case 'close': this.onClose(d); break;
      case 'risk': {
        if (d.event === 'kill') this.say('risk', `KILL SWITCH: drawdown ${d.totalDD.toFixed(1)}% ≥ ${HARD_LIMITS.maxTotalDrawdownPct}%. All new entries halted until reset.`, 'alert');
        if (d.event === 'halt') this.say('risk', `Daily drawdown ${d.dayDD.toFixed(1)}% hit the ${HARD_LIMITS.maxDailyDrawdownPct}% limit. No new entries today.`, 'alert');
        if (d.event === 'cooldown') this.say('risk', `${HARD_LIMITS.lossStreakPause} losses in a row — ${HARD_LIMITS.lossStreakCooldownSec / 60} min cooldown.`, 'alert');
        break;
      }
      case 'equity': this.emit('equity', d); break;
      case 'prune': this.emit('prune', d); break;
    }
  }

  onClose(t) {
    const win = t.pnlSol > 0;
    this.say('exec', `SELL $${t.symbol} ${fmtPct(t.pnlPct)} (${fmtSol(t.pnlSol)} SOL) · ${t.exitReason.replace('_', ' ')} · held ${dur(t.holdSec)} · ${t.strategyName}`, win ? 'win' : 'loss', { mint: t.mint });
    this.emit('trade', { side: 'sell', trade: t });
    if (win) {
      const r = reviewWin(t);
      this.memory.addWin(r.tags);
      if (t.pnlPct > 50 && this.throttled('winreview', 10000)) this.say('critic', `${r.text}. Logging what worked.`, 'info', { mint: t.mint });
    } else {
      // Wait 90s of market time so the Critic can see what happened AFTER we exited.
      this.pendingAutopsy.push({ trade: t, due: t.closeTs + 90_000 });
      this.agents.critic.status = 'working';
    }
  }

  runAutopsies(force = false) {
    if (!this.pendingAutopsy.length) return;
    const now = this.engine.now;
    const keep = [];
    for (const p of this.pendingAutopsy) {
      if (!force && p.due > now) { keep.push(p); continue; }
      const t = p.trade;
      const tok = this.engine.tokens.get(t.mint);
      let after = {};
      if (tok) {
        let maxP = 0, minP = Infinity, n = 0;
        for (const x of tok.trades) if (x.ts > t.closeTs) { n++; if (x.price > maxP) maxP = x.price; if (x.price < minP) minP = x.price; }
        after = { maxPriceAfter: maxP || null, minPriceAfter: minP === Infinity ? null : minP, tradesAfter: n, devSoldPctAfter: tok.features(now).devSoldPct };
      } else after = { tradesAfter: 0 };
      const a = autopsy(t, after);
      this.memory.addLesson({ ts: a.ts, cause: a.cause, symbol: a.symbol, mint: a.mint, strategy: a.strategyName, gen: a.gen, pnlPct: +a.pnlPct.toFixed(1),
        pnlSol: +a.pnlSol.toFixed(4), evidence: a.evidence, secondary: a.secondary });
      if (a.cause === 'dev_rug' || a.cause === 'bundle_dump') this.memory.markRugger(t.creator);
      const fix = a.adjust.length ? ` Proposed fix: ${a.adjust.map((x) => `${x.k} ${x.op === 'set' ? '→ ' + x.v.toFixed?.(2) : x.op === 'add' ? '+' + x.v : '×' + x.v}`).join(', ')}.` : ' No rule change — variance.';
      this.say('critic', `${a.text} Cause: ${a.cause.replace('_', ' ')}.${fix}`, 'loss', { mint: t.mint, cause: a.cause });
      this.memory.ledger(`LOSS AUTOPSY · $${a.symbol} · ${a.strategyName} g${a.gen}`, [
        `PnL ${fmtSol(a.pnlSol)} SOL (${fmtPct(a.pnlPct)}), exit: ${a.exitReason}`,
        `Cause: **${a.cause}** — ${a.evidence}` + (a.secondary.length ? ` (also: ${a.secondary.join(', ')})` : ''),
        `Proposed: ${a.adjust.map((x) => `${x.k} ${x.op} ${typeof x.v === 'number' ? +x.v.toFixed(3) : x.v}`).join('; ') || 'none'}`,
      ], a.ts);
      if (a.adjust.length) {
        const b = this.lossBuckets.get(t.strategyId) || [];
        b.push(a); this.lossBuckets.set(t.strategyId, b);
      }
    }
    this.pendingAutopsy = keep;
    if (!keep.length) this.agents.critic.status = 'idle';
  }

  scoutReport() {
    const now = this.engine.now;
    if (now - this.lastScoutTs < 20000) return;
    const window = (now - this.lastScoutTs) / 1000;
    this.lastScoutTs = now;
    if (!this.counters.launchesWindow) return;
    let alive = 0;
    for (const t of this.engine.tokens.values()) if (now - t.lastTradeTs < 10000) alive++;
    const blocked = Object.entries(this.counters.blocked).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${REASON_TEXT[k] || k} ×${v}`).join(', ');
    this.say('scout', `${this.counters.launchesWindow} launches in last ${Math.round(window)}s · ${alive} coins alive · ${this.engine.tokens.size} tracked${blocked ? ` · top blocks: ${blocked}` : ''}.`);
    this.counters.launchesWindow = 0;
  }

  // ---------------------------------------------------------------- ingest
  ingest(e) {
    if (this.tapeStream) this.tapeStream.write(JSON.stringify(e) + '\n');
    this.tape.push(e);
    if (this.tape.length > this.cfg.tapeMax * 1.1) this.tape.splice(0, this.tape.length - this.cfg.tapeMax);
    if (this.paused) { // keep market state fresh while paused, but block new entries
      const saved = this.engine.strategies; this.engine.strategies = new Map();
      this.engine.handle(e); this.engine.strategies = saved;
    } else this.engine.handle(e);
    return this.afterEvent();
  }

  heartbeat(now = Date.now()) {
    this.engine.advance(now);
    return this.afterEvent();
  }

  afterEvent() {
    if (!this.nextEvolveTs) this.nextEvolveTs = this.engine.now + this.cfg.evolveEverySec * 1000;
    this.runAutopsies();
    this.scoutReport();
    return this.maybeLearn();
  }

  tapeWindow(minutes = this.cfg.evolveWindowMin) {
    const from = this.engine.now - minutes * 60_000;
    let lo = 0, hi = this.tape.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.tape[mid].ts < from) lo = mid + 1; else hi = mid; }
    return this.tape.slice(lo);
  }

  creatorRugObj() { return this.memory.data.creatorRugs; }

  maybeLearn() {
    if (this.learn.busy) return null;
    for (const [sid, list] of this.lossBuckets) {
      const s = this.engine.strategies.get(sid);
      if (!s || !s.active) { this.lossBuckets.delete(sid); continue; }
      const last = this.lastPatch.get(s.family) || -Infinity;
      if (list.length >= this.cfg.patchAfterLosses && this.engine.now - last >= this.cfg.patchCooldownSec * 1000) {
        this.lossBuckets.delete(sid);
        this.lastPatch.set(s.family, this.engine.now);
        return this.runLearning(() => this.doPatch(s, list));
      }
    }
    if (this.engine.now >= this.nextEvolveTs) {
      this.nextEvolveTs = this.engine.now + this.cfg.evolveEverySec * 1000;
      const span = this.tape.length ? (this.tape.at(-1).ts - this.tape[0].ts) / 60000 : 0;
      if (span >= this.cfg.minTapeMin) return this.runLearning(() => this.doEvolve());
      this.say('strategist', `Collecting market tape for backtests (${span.toFixed(1)}/${this.cfg.minTapeMin} min). Evolution starts once there is enough history.`);
    }
    return null;
  }

  runLearning(fn) {
    this.learn.busy = true;
    const t0 = Date.now();
    return fn().catch((err) => this.say('strategist', `Learning step failed: ${err.message}`, 'alert'))
      .finally(() => { this.learn.busy = false; this.learn.lastMs = Date.now() - t0; this.persist(); this.emit('learn', this.learn); });
  }

  promote(parent, child, why, lines = []) {
    child.active = true;
    this.engine.addStrategy(child);
    this.allStrategies.set(child.id, child);
    if (parent) { this.engine.retireStrategy(parent.id); parent.active = false; parent.retiredAt = this.engine.now; parent.successor = child.id; }
    this.memory.addLineage({ ts: this.engine.now, parent: parent?.id || null, child: child.id, name: child.name, gen: child.gen, origin: child.origin, why });
    this.memory.ledger(`PROMOTED · ${child.name} g${child.gen} (${child.origin})`, [why, ...lines], this.engine.now);
    this.learn.promotions++;
  }

  async doPatch(s, autopsies) {
    this.learn.patches++;
    this.agents.strategist.status = 'working';
    this.say('strategist', `${s.name} g${s.gen} took ${autopsies.length} diagnosed losses. Rewriting its rules from the Critic's autopsies and backtesting the patch…`);
    const res = await this.strategist.patch(s, autopsies, this.tapeWindow(Math.min(30, this.cfg.evolveWindowMin)), this.creatorRugObj());
    const changes = (res.changes || []).map((c) => `${c.k} ${c.from}→${c.to}`).join(', ');
    if (res.promoted && this.engine.strategies.get(s.id)?.active) {
      const bt = res.validated ? ` Backtest: ${fmtSol(res.cand.all.pnl)} SOL / ${res.cand.all.n} trades vs parent ${fmtSol(res.base.all.pnl)} / ${res.base.all.n}.` : ' (provisional: not enough tape yet)';
      this.promote(s, res.candidate, `Critic patch for ${res.plan.causes.join(', ')}: ${changes}`, [bt]);
      this.say('strategist', `Promoted ${s.name} g${res.candidate.gen}: ${changes}.${bt}`, 'promote');
    } else {
      this.learn.rejections++;
      this.say('strategist', `Kept ${s.name} g${s.gen} — patch (${changes || 'none'}) ${res.reason}.`, 'info');
      this.memory.ledger(`PATCH REJECTED · ${s.name} g${s.gen}`, [`Causes: ${res.plan?.causes?.join(', ')}`, `Changes: ${changes || 'none'}`, res.reason], this.engine.now);
    }
    this.agents.strategist.status = 'idle';
  }

  async doEvolve() {
    this.learn.cycles++;
    const active = this.engine.activeStrategies();
    const tape = this.tapeWindow();
    this.agents.strategist.status = 'working'; this.agents.researcher.status = 'working';
    this.say('strategist', `Evolution cycle #${this.learn.cycles}: mutating ${active.length} live strategies + crossover + fresh research, backtesting on ${tape.length.toLocaleString()} events (${this.cfg.evolveWindowMin} min tape), out-of-sample check, then stress test.`);
    const liveStats = this.engine.stats;
    const lessons = this.memory.data.causeCounts;
    const llmContext = this.llm?.enabled ? {
      lossCauses: lessons, winTags: this.memory.data.winTags,
      leaderboard: active.map((s) => ({ name: s.name, gen: s.gen, live: liveStats.get(s.id), params: s.params })),
      recentLessons: this.memory.data.lessons.slice(-12),
    } : null;
    const r = await this.strategist.evolve(active, tape, { liveStats, creatorRugs: this.creatorRugObj(), llmContext });
    for (const [id, b] of r.baseFit) this.backtestScores.set(id, { fit: b.fitAll, pnl: b.all.pnl, n: b.all.n, wr: b.all.winRate, ts: this.engine.now });

    for (const a of r.accepted) {
      if (!this.engine.strategies.get(a.parent.id)?.active) continue;
      const ch = diffParams(a.parent.params, a.child.params).slice(0, 5).map((c) => `${c.k} ${c.from}→${c.to}`).join(', ');
      const why = `Mutation beat parent: IS ${fmtSol(a.after.is.pnl)} vs ${fmtSol(a.before.is.pnl)}, OOS ${fmtSol(a.after.oos.pnl)} vs ${fmtSol(a.before.oos.pnl)} SOL; stress ${fmtSol(a.stress.all.pnl)} SOL, DD ${a.stress.all.maxDD.toFixed(3)}`;
      this.promote(a.parent, a.child, why, [`Changes: ${ch}`]);
      this.backtestScores.set(a.child.id, { fit: a.after.fitAll, pnl: a.after.all.pnl, n: a.after.all.n, wr: a.after.all.winRate, ts: this.engine.now });
      this.say('strategist', `Promoted ${a.child.name} g${a.child.gen}: ${ch}. ${why}.`, 'promote');
    }
    for (const a of r.rejected) {
      this.learn.rejections++;
      this.say('risk', `Blocked promotion of ${a.child.name} g${a.child.gen}: failed stress test (3× latency, 20% failed txs)${a.stress ? ` → ${fmtSol(a.stress.all.pnl)} SOL, DD ${a.stress.all.maxDD.toFixed(3)}` : ''}.`, 'warn');
    }
    for (const x of r.retire) {
      if (!this.engine.strategies.get(x.strategy.id)?.active) continue;
      this.engine.retireStrategy(x.strategy.id); x.strategy.active = false; x.strategy.retiredAt = this.engine.now;
      this.learn.retired++;
      const why = x.replaced ? 'replaced by stronger research' : `live ${fmtSol(x.live.pnl)} SOL over ${x.live.n} trades and backtest ${fmtSol(x.bt.all.pnl)}`;
      this.say('strategist', `Retired ${x.strategy.name} g${x.strategy.gen}: ${why}.`, 'warn');
      this.memory.ledger(`RETIRED · ${x.strategy.name} g${x.strategy.gen}`, [why], this.engine.now);
    }
    if (r.adopt) {
      const s = r.adopt.strategy;
      this.learn.adopted++;
      this.promote(null, s, `New ${s.origin} strategy: backtest ${fmtSol(r.adopt.result.all.pnl)} SOL over ${r.adopt.result.all.n} trades, stress ${fmtSol(r.adopt.stress.all.pnl)}`, [s.thesis]);
      this.backtestScores.set(s.id, { fit: r.adopt.result.fitAll, pnl: r.adopt.result.all.pnl, n: r.adopt.result.all.n, wr: r.adopt.result.all.winRate, ts: this.engine.now });
      this.say('researcher', `New strategy "${s.name}" joins the desk (${s.origin}). ${s.thesis} Backtest ${fmtSol(r.adopt.result.all.pnl)} SOL / ${r.adopt.result.all.n} trades, win ${(r.adopt.result.all.winRate * 100).toFixed(0)}%.`, 'promote');
    } else this.say('researcher', `Tested ${r.candidates} candidates. No new strategy beat the desk median out-of-sample — keeping the current lineup.`);
    if (!r.accepted.length && !r.retire.length) this.say('strategist', `Cycle #${this.learn.cycles} done in ${(r.ms / 1000).toFixed(1)}s: no mutation beat its parent both in- and out-of-sample. Current params hold.`);
    this.learn.last = `cycle ${this.learn.cycles}: +${r.accepted.length} promoted, ${r.rejected.length} stress-rejected, ${r.retire.length} retired${r.adopt ? ', 1 new' : ''}`;
    this.agents.strategist.status = 'idle'; this.agents.researcher.status = 'idle';
  }

  forceEvolve() { this.nextEvolveTs = 0; return this.maybeLearn(); }

  reset() {
    const e = this.engine;
    e.liquidateAll('reset');
    e.cash = this.startingSol; e.closed = []; e.equityHist = []; e.risk.reset(this.startingSol);
    for (const k of e.stats.keys()) e.stats.set(k, { n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, cum: 0, peak: 0, maxDD: 0, lastTs: 0, fails: 0 });
    this.say('risk', `Paper account reset to ${this.startingSol} SOL. Kill switch cleared. Strategy memory and lessons kept.`, 'alert');
    this.persist();
  }

  // ---------------------------------------------------------------- UI snapshot
  portfolio() {
    const e = this.engine;
    const eq = e.equity();
    const closed = e.closed;
    const wins = closed.filter((t) => t.pnlSol > 0).length;
    let peak = -Infinity, maxDD = 0;
    for (const [, v] of e.equityHist) { if (v > peak) peak = v; maxDD = Math.max(maxDD, (1 - v / peak) * 100); }
    const dayStart = e.risk.dayStartEquity;
    return { equity: eq, cash: e.cash, start: this.startingSol, pnl: eq - this.startingSol, pnlPct: (eq / this.startingSol - 1) * 100,
      dayPnl: eq - dayStart, trades: closed.length, winRate: closed.length ? wins / closed.length : 0, open: e.positions.size, maxDD,
      realized: closed.reduce((s, t) => s + t.pnlSol, 0) };
  }

  positions() {
    const e = this.engine;
    return [...e.positions.values()].map((p) => {
      const t = e.tokens.get(p.mint);
      const price = t ? t.price : p.entryPrice;
      return { id: p.id, mint: p.mint, symbol: p.symbol, name: p.name, strategy: p.strategyName, gen: p.gen, openTs: p.openTs,
        costSol: p.costSol, pnlPct: (price / p.entryPrice - 1) * 100, peakPct: (p.peakPrice / p.entryPrice - 1) * 100,
        mcap: t ? t.mcap : 0, tp1Hit: p.tp1Hit, stop: p.params.stopLossPct, valueSol: t ? (p.tokensLeft * price * (1 - 0.0125)) + p.proceedsSol : p.proceedsSol };
    });
  }

  strategies() {
    const out = [];
    for (const s of this.allStrategies.values()) {
      if (!s.active && this.engine.now - (s.retiredAt || 0) > 3_600_000) continue;
      const st = this.engine.stats.get(s.id) || { n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, maxDD: 0 };
      out.push({ id: s.id, name: s.name, family: s.family, gen: s.gen, origin: s.origin, active: s.active, thesis: s.thesis, archetype: s.archetype,
        live: { n: st.n, wins: st.wins, pnl: st.pnl, pf: st.grossLoss > 0 ? st.grossWin / st.grossLoss : st.grossWin > 0 ? 99 : 0, maxDD: st.maxDD },
        bt: this.backtestScores.get(s.id) || null,
        params: (({ entryDelaySec, minUniqueBuyers, minVel10, maxDevHoldPct, maxBundlePct, minWhaleSol30, stopLossPct, takeProfitPct, trailingStopPct, sizePct }) =>
          ({ entryDelaySec, minUniqueBuyers, minVel10, maxDevHoldPct, maxBundlePct, minWhaleSol30, stopLossPct, takeProfitPct, trailingStopPct, sizePct }))(s.params) });
    }
    return out.sort((a, b) => (b.active - a.active) || (b.live.pnl - a.live.pnl));
  }

  coins(limit = 40) {
    const e = this.engine;
    const now = e.now;
    const held = new Set(e.byMint.keys());
    const rows = [];
    const seen = new Set();
    for (const mint of [...held, ...this.coinOrder]) {
      if (seen.has(mint)) continue;
      seen.add(mint);
      const t = e.tokens.get(mint);
      if (!t) continue;
      const r = t.toRow(now);
      r.held = held.has(mint);
      r.rugs = this.memory.creatorRugs(t.creator);
      r.score = scoreToken(t.features(now), r.whale);
      rows.push(r);
      if (rows.length >= limit) break;
    }
    return rows;
  }

  snapshot() {
    return {
      now: this.engine.now, paused: this.paused, portfolio: this.portfolio(), positions: this.positions(), strategies: this.strategies(),
      agents: Object.values(this.agents), messages: this.messages.slice(-150), equity: this.engine.equityHist.slice(-2000),
      lessons: this.memory.recentLedger(30), causes: this.memory.data.causeCounts, learn: { ...this.learn, nextEvolveIn: Math.max(0, (this.nextEvolveTs - this.engine.now) / 1000) },
      risk: { ...this.engine.risk.status(), limits: HARD_LIMITS }, counters: this.counters, coins: this.coins(), trades: this.engine.closed.slice(-40).reverse().map(stripTrade),
      llm: this.llm?.provider || 'off', ruggers: Object.keys(this.memory.data.creatorRugs).length,
    };
  }
}

export function stripTrade(t) {
  const { path: p, entryFeatures, params, exits, ...rest } = t;
  return rest;
}
