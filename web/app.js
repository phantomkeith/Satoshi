// GrokDesk UI client: live websocket -> coin feed, portfolio chart, desk chat, lab.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const LS = { get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

  const S = { coins: [], portfolio: null, positions: [], strategies: [], agents: [], messages: [], equity: [], lessons: [], causes: {}, trades: [],
    meta: {}, learn: {}, risk: {}, counters: {}, paused: false, ruggers: 0 };
  const ui = { feedFilter: 'all', range: +LS.get('range', '3600'), chatFilter: 'all', lab: LS.get('lab', 'strategies'), tab: LS.get('tab', 'market') };
  const prevCoins = new Map();
  const dirty = new Set();
  const chart = new window.EquityChart($('#chart'), $('#chart-tip'));

  // ------------------------------------------------------------ formatting
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (sol) => { const v = sol * (S.meta.solUsd || 0); return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`; };
  const age = (s) => s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  const sgn = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
  const cls = (x) => (x >= 0 ? 'up' : 'down');
  const hue = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h % 360; };
  const hhmmss = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  // ------------------------------------------------------------ connection
  function wsUrl() {
    const b = LS.get('backend').trim();
    if (b) return b.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  function apiUrl(p) { const b = LS.get('backend').trim().replace(/\/$/, ''); return (b || '') + p; }
  let ws, retry = 800;
  function connect() {
    if (location.protocol === 'file:' && !LS.get('backend')) { setFeedPill(false, 'set backend URL'); return; }
    try { ws = new WebSocket(wsUrl()); } catch { setFeedPill(false, 'bad backend URL'); return; }
    ws.onopen = () => { retry = 800; };
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); handle(m.t, m.d); };
    ws.onclose = () => { setFeedPill(false, 'reconnecting…'); setTimeout(connect, retry); retry = Math.min(retry * 1.7, 10000); };
  }

  function handle(t, d) {
    switch (t) {
      case 'snapshot':
        Object.assign(S, d); S.meta = d.meta || {}; S.paused = d.paused;
        ['coins', 'portfolio', 'agents', 'chat', 'lab', 'positions', 'chart', 'meta', 'learn'].forEach((k) => dirty.add(k));
        $('#chat').innerHTML = ''; S.messages.forEach((m) => appendMsg(m, false)); scrollChat(true);
        break;
      case 'coins': S.coins = d; dirty.add('coins'); break;
      case 'state':
        S.portfolio = d.portfolio; S.positions = d.positions; S.agents = d.agents; S.learn = d.learn; S.risk = d.risk; S.counters = d.counters; S.meta = d.meta; S.paused = d.paused; S.now = d.now;
        ['portfolio', 'agents', 'positions', 'meta', 'learn'].forEach((k) => dirty.add(k));
        break;
      case 'eq': S.equity.push(d); if (S.equity.length > 6000) S.equity.splice(0, 1000); dirty.add('chart'); break;
      case 'msg': S.messages.push(d); if (S.messages.length > 300) S.messages.splice(0, 100); appendMsg(d, true); break;
      case 'slow': S.strategies = d.strategies; S.lessons = d.lessons; S.causes = d.causes; S.trades = d.trades; S.ruggers = d.ruggers; dirty.add('lab'); break;
      case 'trade': break;
    }
  }

  // ------------------------------------------------------------ render loop
  function frame() {
    if (dirty.size) {
      if (dirty.has('coins')) renderCoins();
      if (dirty.has('portfolio')) renderPortfolio();
      if (dirty.has('positions')) renderPositions();
      if (dirty.has('chart')) renderChart();
      if (dirty.has('agents')) renderAgents();
      if (dirty.has('lab')) renderLab();
      if (dirty.has('meta')) renderMeta();
      if (dirty.has('learn')) renderLearn();
      dirty.clear();
    }
    requestAnimationFrame(frame);
  }

  function setFeedPill(ok, text, detail = '') {
    const p = $('#pill-feed'); p.classList.toggle('ok', ok); p.classList.toggle('bad', !ok);
    p.querySelector('span').innerHTML = `${esc(text)}${detail ? `<span class="hide-sm"> · ${esc(detail)}</span>` : ''}`;
  }

  function renderMeta() {
    const m = S.meta;
    const live = m.mode && m.mode !== 'sim';
    setFeedPill(!!m.feed?.connected, m.feed?.connected ? (live ? 'LIVE' : 'SIM') : 'OFFLINE', m.mode === 'pumpportal' ? 'PumpPortal' : m.mode === 'rpc' ? 'Solana RPC' : 'Synthetic market');
    $('#pill-sol').textContent = `SOL $${(m.solUsd || 0).toFixed(2)}`;
    $('#pill-llm').textContent = `AI ${m.llm && m.llm !== 'off' ? m.llm.split(' ')[0] : 'heuristic'}`;
    const b = $('#btn-pause'); b.textContent = S.paused ? 'Resume' : 'Pause'; b.classList.toggle('on', S.paused);
  }

  // ------------------------------------------------------------ coin feed
  function coinVisible(c) {
    if (ui.feedFilter === 'alive') return c.gap < 15;
    if (ui.feedFilter === 'held') return c.held;
    if (ui.feedFilter === 'safe') return c.devPct < 8 && c.bundlePct < 8 && c.top10 < 45 && !c.rugs && c.devSold < 0.1;
    return true;
  }
  function spark(arr, up) {
    if (!arr || arr.length < 2) return '';
    let mn = Infinity, mx = -Infinity; for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const r = mx - mn || 1;
    const pts = arr.map((v, i) => `${(i / (arr.length - 1) * 100).toFixed(1)},${(17 - ((v - mn) / r) * 15).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 100 18" preserveAspectRatio="none"><polyline points="${pts}" stroke="${up ? '#19f08c' : '#ff4d6a'}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function scoreRing(s) {
    const col = s >= 65 ? '#19f08c' : s >= 40 ? '#f5b53d' : '#ff4d6a';
    const C = 2 * Math.PI * 18;
    return `<div class="score" style="color:${col}"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" stroke="#1a212b"/><circle cx="22" cy="22" r="18" stroke="${col}" stroke-dasharray="${(C * s / 100).toFixed(1)} ${C.toFixed(1)}" stroke-linecap="round"/></svg>${s}</div>`;
  }
  function coinHTML(c) {
    const h = hue(c.mint);
    const av = c.image ? `<div class="av"><img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></div>`
      : `<div class="av" style="background:linear-gradient(135deg,hsl(${h} 70% 45%),hsl(${(h + 60) % 360} 70% 30%))">${esc((c.symbol || '?').slice(0, 2))}</div>`;
    const tags = [];
    if (c.held) tags.push('<span class="tag g">SNIPED</span>');
    if (c.migrated) tags.push('<span class="tag v">GRAD</span>');
    if (c.whale >= 2) tags.push(`<span class="tag c">🐋 ${c.whale.toFixed(1)}</span>`);
    const safety = [];
    if (c.rugs) safety.push(`<span class="tag r">RUGGER×${c.rugs}</span>`);
    if (c.devSold > 0.2) safety.push('<span class="tag r">DEV SOLD</span>');
    else safety.push(`<span class="tag ${c.devPct > 10 ? 'r' : c.devPct > 5 ? 'a' : 'g'}">DEV ${c.devPct.toFixed(1)}%</span>`);
    if (c.bundlePct > 0.5) safety.push(`<span class="tag ${c.bundlePct > 10 ? 'r' : 'a'}">BNDL ${c.bundlePct.toFixed(0)}%</span>`);
    safety.push(`<span class="tag ${c.top10 > 45 ? 'a' : 'g'}">T10 ${c.top10.toFixed(0)}%</span>`);
    if (c.socials === true) safety.push('<span class="tag c">SOC</span>');
    const tot = c.buyVol + c.sellVol || 1;
    const up = c.spark.length > 1 ? c.spark[c.spark.length - 1] >= c.spark[0] : true;
    return `<div class="c-id">${av}<div class="c-name"><div class="c-sym"><span class="c-tk">${esc(c.symbol)}</span>${tags.join('')}</div><div class="c-sub">${age(c.age)} · ${esc(c.name)}${c.gap > 15 ? ' · quiet' : ''}</div></div></div>
      <div class="c-mc"><b>${c.mcap.toFixed(1)}◎</b><span>${usd(c.mcap)}</span></div>
      <div class="c-curve hide-sm">${c.progress.toFixed(0)}% · ${c.holders} hold<div class="bar"><i style="width:${Math.min(100, c.progress)}%"></i></div></div>
      <div class="flow"><span class="fl-t">${c.vel10} tx/10s · ${c.buyers} buyers</span><div class="bs"><i style="width:${(c.buyVol / tot * 100).toFixed(0)}%"></i><i style="width:${(c.sellVol / tot * 100).toFixed(0)}%"></i></div>${spark(c.spark, up)}</div>
      <div class="safety hide-md">${safety.join('')}</div>
      ${scoreRing(c.score || 0)}`;
  }
  const rowEls = new Map();
  function renderCoins() {
    const list = $('#feed-list');
    const coins = S.coins.filter(coinVisible);
    $('#feed-count').textContent = `· ${S.counters.launches || 0} seen`;
    if (!coins.length) { list.innerHTML = `<div class="empty">${ui.feedFilter === 'held' ? 'No open snipes right now.' : 'Waiting for launches…'}</div>`; rowEls.clear(); return; }
    const keep = new Set();
    let prev = null;
    for (const c of coins) {
      keep.add(c.mint);
      let el = rowEls.get(c.mint);
      const old = prevCoins.get(c.mint);
      if (!el) { el = document.createElement('div'); el.className = 'coin new'; rowEls.set(c.mint, el); setTimeout(() => el.classList.remove('new'), 500); }
      el.innerHTML = coinHTML(c);
      el.classList.toggle('held', !!c.held);
      el.classList.toggle('dead', c.gap > 30 && !c.held);
      if (old) {
        if (c.buys > old.buys) { el.classList.add('flash-b'); setTimeout(() => el.classList.remove('flash-b'), 350); }
        else if (c.sells > old.sells) { el.classList.add('flash-s'); setTimeout(() => el.classList.remove('flash-s'), 350); }
      }
      prevCoins.set(c.mint, { buys: c.buys, sells: c.sells });
      const want = prev ? prev.nextSibling : list.firstChild;
      if (want !== el) list.insertBefore(el, want);
      prev = el;
    }
    for (const [m, el] of rowEls) if (!keep.has(m)) { el.remove(); rowEls.delete(m); }
    const empty = list.querySelector('.empty'); if (empty) empty.remove();
    if (prevCoins.size > 800) for (const k of [...prevCoins.keys()].slice(0, 400)) prevCoins.delete(k);
  }

  // ------------------------------------------------------------ portfolio
  function renderPortfolio() {
    const p = S.portfolio; if (!p) return;
    $('#eq-main').textContent = `${p.equity.toFixed(3)} SOL`;
    $('#eq-usd').textContent = usd(p.equity);
    const ch = $('#eq-chg'); ch.textContent = `${sgn(p.pnl, 3)} SOL (${sgn(p.pnlPct, 2)}%)`; ch.className = `chg ${cls(p.pnl)}`;
    $('#t-wr').textContent = p.trades ? `${(p.winRate * 100).toFixed(0)}%` : '—';
    $('#t-n').textContent = p.trades;
    $('#t-open').textContent = `${p.open}`;
    const day = $('#t-day'); day.textContent = sgn(p.dayPnl, 3); day.className = cls(p.dayPnl);
    $('#t-dd').textContent = `${p.maxDD.toFixed(1)}%`;
    const r = S.risk || {}, b = $('#risk-badge');
    if (r.killed) { b.textContent = 'KILL SWITCH'; b.className = 'risk-badge bad'; }
    else if (r.haltedToday) { b.textContent = 'DAILY HALT'; b.className = 'risk-badge bad'; }
    else if (r.pausedUntil > (S.now || 0)) { b.textContent = 'COOLDOWN'; b.className = 'risk-badge warn'; }
    else if (S.paused) { b.textContent = 'PAUSED'; b.className = 'risk-badge warn'; }
    else { b.textContent = 'RISK OK · ≤2%/trade'; b.className = 'risk-badge'; }
  }
  function renderPositions() {
    const el = $('#positions');
    if (!S.positions.length) { el.innerHTML = '<div class="pos-empty">No open positions — the team is hunting.</div>'; return; }
    el.innerHTML = S.positions.map((p) => `<div class="pos"><div><b>$${esc(p.symbol)}</b> <span class="s">${esc(p.strategy)} g${p.gen}</span></div>
      <div class="${cls(p.pnlPct)}">${sgn(p.pnlPct)}% <span class="s">peak ${sgn(p.peakPct, 0)}%</span></div>
      <div>${p.costSol.toFixed(3)}◎</div><div class="s">${p.mcap.toFixed(0)}◎ mc</div></div>`).join('');
  }
  function renderChart() {
    const all = S.equity;
    if (!all.length) { chart.set([], S.portfolio?.start || 10, S.meta.solUsd); return; }
    const end = all[all.length - 1][0];
    const data = ui.range ? all.filter(([t]) => t >= end - ui.range * 1000) : all;
    chart.set(data, S.portfolio?.start || data[0][1], S.meta.solUsd);
  }

  // ------------------------------------------------------------ desk
  const AG_ICON = { scout: 'SC', sentinel: 'SN', quant: 'QT', risk: 'RK', exec: 'EX', critic: 'CR', strategist: 'ST', researcher: 'RS' };
  function renderAgents() {
    $('#agents').innerHTML = S.agents.map((a) => `<div class="agent ${a.status}">
      <div class="ag-av" style="background:${a.color}22;color:${a.color};box-shadow:inset 0 0 0 1px ${a.color}55">${AG_ICON[a.id] || a.name[0]}</div>
      <div><div class="ag-top"><span class="ag-name">${esc(a.name)}</span><span class="ag-n">${a.count}</span></div>
      <div class="ag-role">${esc(a.role)}</div><div class="ag-last">${esc(a.last || 'Standing by…')}</div></div></div>`).join('');
  }
  const agentColor = (id) => (S.agents.find((a) => a.id === id) || {}).color || '#888';
  const agentName = (id) => (S.agents.find((a) => a.id === id) || {}).name || id;
  function msgVisible(m) {
    if (ui.chatFilter === 'trades') return m.agent === 'exec' || m.level === 'buy' || m.level === 'win';
    if (ui.chatFilter === 'learn') return ['critic', 'strategist', 'researcher'].includes(m.agent);
    return true;
  }
  function appendMsg(m, live) {
    if (!msgVisible(m)) return;
    const chat = $('#chat');
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
    const el = document.createElement('div');
    el.className = `msg ${m.level}`;
    const txt = esc(m.text).replace(/\$([A-Z0-9]{2,12})/g, '<span class="sym">$$$1</span>');
    el.innerHTML = `<time>${hhmmss(m.ts)}</time><span class="who" style="color:${agentColor(m.agent)}">${esc(agentName(m.agent))}</span><span class="txt">${txt}</span>`;
    chat.appendChild(el);
    while (chat.children.length > 250) chat.firstChild.remove();
    if (live && atBottom) scrollChat();
  }
  function scrollChat() { const c = $('#chat'); c.scrollTop = c.scrollHeight; }
  function rebuildChat() { $('#chat').innerHTML = ''; S.messages.forEach((m) => appendMsg(m, false)); scrollChat(); }

  function renderLearn() {
    const l = S.learn || {};
    const busy = l.busy ? '<b style="color:var(--amber)">● evolving</b>' : `next cycle in <b>${Math.ceil((l.nextEvolveIn || 0) / 60)}m</b>`;
    $('#learn-strip').innerHTML = `${busy} · cycles <b>${l.cycles || 0}</b> · patches <b>${l.patches || 0}</b> · promoted <b>${l.promotions || 0}</b> · rejected <b>${l.rejections || 0}</b> · retired <b>${l.retired || 0}</b> · ruggers <b>${S.ruggers || 0}</b>`;
  }

  function renderLab() {
    const el = $('#lab');
    if (ui.lab === 'strategies') {
      if (!S.strategies.length) { el.innerHTML = '<div class="empty">Loading strategies…</div>'; return; }
      el.innerHTML = S.strategies.map((s) => {
        const wr = s.live.n ? `${(s.live.wins / s.live.n * 100).toFixed(0)}%` : '—';
        const p = s.params;
        return `<div class="strat ${s.active ? '' : 'retired'}">
          <div class="st-top"><span class="st-name">${esc(s.name)}</span><span class="st-meta">g${s.gen} · ${esc(s.origin)}${s.active ? '' : ' · retired'}</span></div>
          <div class="st-stats"><div><span>Live PnL</span><b class="${cls(s.live.pnl)}">${sgn(s.live.pnl, 3)}</b></div><div><span>Trades</span>${s.live.n}</div><div><span>Win</span>${wr}</div>
          <div><span>Backtest</span>${s.bt ? `<b class="${cls(s.bt.pnl)}">${sgn(s.bt.pnl, 2)}</b>` : '—'}</div></div>
          <div class="st-params"><span class="tag">delay ${p.entryDelaySec}s</span><span class="tag">buyers ≥${p.minUniqueBuyers}</span><span class="tag">vel ≥${p.minVel10}</span>
          <span class="tag">dev ≤${p.maxDevHoldPct}%</span><span class="tag">bundle ≤${p.maxBundlePct}%</span>${p.minWhaleSol30 > 0 ? `<span class="tag">whale ≥${p.minWhaleSol30}◎</span>` : ''}
          <span class="tag">SL ${p.stopLossPct}%</span><span class="tag">TP ${p.takeProfitPct}%</span><span class="tag">trail ${p.trailingStopPct}%</span><span class="tag">size ${p.sizePct}%</span></div>
          ${s.thesis ? `<div class="st-thesis">${esc(s.thesis)}</div>` : ''}</div>`;
      }).join('');
    } else if (ui.lab === 'lessons') {
      const causes = Object.entries(S.causes || {}).sort((a, b) => b[1] - a[1]);
      const max = causes.length ? causes[0][1] : 1;
      el.innerHTML = `<div class="h3">What keeps hurting us</div>${causes.length ? causes.map(([k, v]) => `<div class="cause"><span>${esc(k.replace(/_/g, ' '))}</span><div class="bar"><i style="width:${(v / max * 100).toFixed(0)}%"></i></div><span>${v}</span></div>`).join('') : '<div class="pos-empty">No losses diagnosed yet.</div>'}
        <div class="h3" style="margin-top:14px">Recent autopsies</div>
        ${(S.lessons || []).map((l) => `<div class="lesson"><b>$${esc(l.symbol)}</b> <span class="down">${sgn(l.pnlPct)}%</span> · ${esc(l.strategy)} g${l.gen} · <b>${esc(l.cause)}</b><div class="ev">${esc(l.evidence)}</div></div>`).join('')}`;
    } else {
      el.innerHTML = (S.trades || []).length ? (S.trades || []).map((t) => `<div class="trow"><div><b>$${esc(t.symbol)}</b><div class="s">${esc(t.strategyName)}</div></div>
        <div class="s">${esc(t.exitReason.replace(/_/g, ' '))} · ${age(t.holdSec)}</div><div class="${cls(t.pnlPct)}">${sgn(t.pnlPct)}%</div><div class="${cls(t.pnlSol)}">${sgn(t.pnlSol, 3)}</div></div>`).join('')
        : '<div class="empty">No closed trades yet.</div>';
    }
  }

  // ------------------------------------------------------------ controls
  function seg(sel, attr, cb) {
    const root = $(sel);
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      root.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      cb(b.dataset[attr]);
    });
  }
  const setOn = (sel, attr, val) => document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(val)));
  seg('#feed-filter', 'f', (v) => { ui.feedFilter = v; dirty.add('coins'); });
  seg('#range', 'r', (v) => { ui.range = +v; LS.set('range', v); dirty.add('chart'); });
  seg('#chat-filter', 'c', (v) => { ui.chatFilter = v; rebuildChat(); });
  seg('#lab-tabs', 'l', (v) => { ui.lab = v; LS.set('lab', v); dirty.add('lab'); });
  setOn('#range', 'r', ui.range); setOn('#lab-tabs', 'l', ui.lab);
  function setTab(t) { ui.tab = t; LS.set('tab', t); document.body.dataset.tab = t; setOn('#tabbar', 'tab', t); dirty.add('chart'); if (t === 'desk') setTimeout(scrollChat, 0); }
  $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  setTab(ui.tab);

  async function control(action) {
    try {
      const r = await fetch(apiUrl('/api/control'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': LS.get('token') }, body: JSON.stringify({ action }) });
      if (r.status === 401) alert('Control token required (Settings).');
    } catch { alert('Backend unreachable.'); }
  }
  $('#btn-pause').onclick = () => control(S.paused ? 'resume' : 'pause');
  $('#btn-evolve').onclick = () => control('evolve');
  const dlg = $('#settings');
  $('#btn-settings').onclick = () => { $('#set-backend').value = LS.get('backend'); $('#set-token').value = LS.get('token'); $('#ledger-link').href = apiUrl('/api/ledger'); dlg.showModal(); };
  $('#set-save').onclick = () => { const old = LS.get('backend'); LS.set('backend', $('#set-backend').value.trim()); LS.set('token', $('#set-token').value); if (old !== LS.get('backend')) { try { ws?.close(); } catch { /* ignore */ } } };
  $('#btn-reset').onclick = () => { if (confirm('Reset the paper account to its starting balance? Lessons and strategies are kept.')) { control('reset'); dlg.close(); } };

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.Capacitor) navigator.serviceWorker.register('sw.js').catch(() => {});
  connect();
  requestAnimationFrame(frame);
})();
