// GrokDesk server: market feed -> AI desk -> websocket UI (+ static web/PWA).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';
import { Desk } from './desk.js';
import { Memory } from './learn/memory.js';
import { BacktestService } from './learn/backtestService.js';
import { LLM } from './agents/llm.js';
import { SimFeed } from './sim/market.js';
import { PumpPortalFeed } from './feeds/pumpportal.js';
import { SolanaRpcFeed } from './feeds/solanaRpc.js';
import { MetadataFetcher, SolPrice } from './feeds/services.js';

const mode = config.feedMode;
// Keep sim and live learning separate: lessons from synthetic data must not leak into live memory.
const dataDir = path.join(config.dataDir, mode === 'sim' ? 'sim' : 'live');
const cfg = { ...config, dataDir };
const memory = new Memory(dataDir);
// First run: start from the strategies that passed `npm run evaluate` (if present) instead of raw seeds.
if (!(memory.data.strategies || []).some((s) => s.active)) {
  try {
    const learned = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'learned-strategies.json'), 'utf8'));
    if (learned.length >= 3) memory.data.strategies = learned.map((s) => ({ ...s, active: true, origin: `${s.origin}+evaluated` }));
  } catch { /* no evaluated lineup yet */ }
}
const llm = new LLM(config.llm);
const backtests = new BacktestService({ mode: 'worker' });
const desk = new Desk({ config: cfg, memory, llm, backtests });

const feed = mode === 'pumpportal' ? new PumpPortalFeed({ url: config.pumpPortalWs })
  : mode === 'rpc' ? new SolanaRpcFeed({ wsUrl: config.solanaWs })
  : new SimFeed({ launchesPerMin: config.simLaunchesPerMin });
const meta = mode !== 'sim' && config.fetchMetadata ? new MetadataFetcher() : null;
const solPrice = new SolPrice();
let feedStatus = { connected: false, source: feed.name };
let eventsIn = 0;

feed.on('status', (s) => {
  feedStatus = s;
  desk.say('scout', s.connected ? `Connected to ${s.source}. Listening for new Pump.fun launches.` : `Feed issue (${s.source}): ${s.error || 'disconnected'}. Reconnecting…`, s.connected ? 'info' : 'alert');
});
feed.on('event', (e) => {
  eventsIn++;
  if (e.type === 'create' && meta) meta.push(e.mint, e.uri);
  desk.ingest(e);
});
meta?.on('event', (e) => desk.ingest(e));
desk.on('prune', (mints) => feed.untrack?.(mints));

// ------------------------------------------------------------------ HTTP + static
const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';

function meta_() {
  return { mode, feed: feedStatus, solUsd: solPrice.usd, solSource: solPrice.source, llm: llm.provider, paper: true, eventsIn,
    exec: desk.engine.exec, controlLocked: !!CONTROL_TOKEN };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-control-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/state') return json(res, { ...desk.snapshot(), meta: meta_() });
  if (url.pathname === '/api/health') return json(res, { ok: true, mode, feed: feedStatus, eventsIn, uptime: process.uptime() });
  if (url.pathname === '/api/ledger') {
    try { res.writeHead(200, { 'content-type': MIME['.md'] }); return res.end(fs.readFileSync(path.join(dataDir, 'ledger.md'))); }
    catch { return json(res, { error: 'no ledger yet' }, 404); }
  }
  if (url.pathname === '/api/control' && req.method === 'POST') {
    if (CONTROL_TOKEN && req.headers['x-control-token'] !== CONTROL_TOKEN) return json(res, { error: 'unauthorized' }, 401);
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1e4) break; }
    let action;
    try { ({ action } = JSON.parse(body || '{}')); } catch { return json(res, { error: 'bad json' }, 400); }
    if (action === 'pause') { desk.paused = true; desk.say('risk', 'Desk paused by operator. Managing open positions only.', 'alert'); }
    else if (action === 'resume') { desk.paused = false; desk.say('risk', 'Desk resumed by operator.', 'info'); }
    else if (action === 'reset') desk.reset();
    else if (action === 'evolve') { desk.forceEvolve(); }
    else return json(res, { error: 'unknown action' }, 400);
    broadcastState();
    return json(res, { ok: true, paused: desk.paused });
  }
  // static
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': p === '/sw.js' ? 'no-cache' : 'no-cache' });
    res.end(data);
  });
});

function json(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

// ------------------------------------------------------------------ websocket push
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 1024 } });
const send = (ws, t, d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t, d })); };
const broadcast = (t, d) => { if (!wss.clients.size) return; const s = JSON.stringify({ t, d }); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };

wss.on('connection', (ws) => send(ws, 'snapshot', { ...desk.snapshot(), meta: meta_() }));
desk.on('message', (m) => broadcast('msg', m));
desk.on('equity', (e) => broadcast('eq', [e.ts, +e.equity.toFixed(5)]));
desk.on('trade', (t) => broadcast('trade', t.side === 'sell' ? { side: 'sell', mint: t.trade.mint, symbol: t.trade.symbol, pnlPct: t.trade.pnlPct, pnlSol: t.trade.pnlSol } : { side: 'buy', mint: t.pos.mint, symbol: t.pos.symbol }));

function broadcastState() {
  broadcast('state', { now: desk.engine.now, paused: desk.paused, portfolio: desk.portfolio(), positions: desk.positions(), agents: Object.values(desk.agents),
    learn: { ...desk.learn, nextEvolveIn: Math.max(0, (desk.nextEvolveTs - desk.engine.now) / 1000) }, risk: { ...desk.engine.risk.status() },
    counters: desk.counters, meta: meta_() });
}
setInterval(() => broadcast('coins', desk.coins()), 500);
setInterval(broadcastState, 1000);
setInterval(() => broadcast('slow', { strategies: desk.strategies(), lessons: desk.memory.recentLedger(30), causes: desk.memory.data.causeCounts,
  trades: desk.engine.closed.slice(-40).reverse().map(({ path: _p, entryFeatures: _e, params: _q, exits: _x, ...r }) => r), ruggers: Object.keys(desk.memory.data.creatorRugs).length }), 3000);

// Heartbeat drives exits on coins that stop trading (dead-coin detection) between events.
setInterval(() => desk.heartbeat(Date.now()), 250);
// Agents fall back to idle when quiet.
setInterval(() => { const now = desk.engine.now; for (const a of Object.values(desk.agents)) if (a.status !== 'idle' && now - a.ts > 8000 && !(a.id === 'strategist' && desk.learn.busy)) a.status = 'idle'; }, 1000);
setInterval(() => desk.persist(), 30_000);

server.listen(config.port, config.host, () => {
  console.log(`\n  GrokDesk Sniper Team · PAPER TRADING`);
  console.log(`  feed: ${feed.name} (${mode})   llm: ${llm.provider}   data: ${dataDir}`);
  console.log(`  open http://localhost:${config.port}\n`);
  solPrice.start();
  feed.start();
  desk.say('strategist', `Desk online in PAPER mode with ${desk.engine.activeStrategies().length} strategies, ${desk.engine.cash.toFixed(2)} SOL. Hard limits: ≤2% per trade, ≤${desk.engine.risk.L.maxOpenPositions} positions, ${desk.engine.risk.L.maxDailyDrawdownPct}% daily / ${desk.engine.risk.L.maxTotalDrawdownPct}% total drawdown stop.`);
});

const shutdown = () => { try { desk.persist(); } catch { /* ignore */ } feed.stop(); backtests.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
