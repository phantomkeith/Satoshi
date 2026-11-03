// Tiny dependency-free canvas area chart for the equity curve.
(function () {
  class EquityChart {
    constructor(canvas, tip) {
      this.c = canvas; this.tip = tip; this.data = []; this.base = 0; this.hover = null;
      this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(canvas.parentElement);
      canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); this.hover = e.clientX - r.left; this.draw(); });
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.display = 'none'; this.draw(); });
    }
    set(data, base, usd) { this.data = data; this.base = base; this.usd = usd; this.draw(); }
    draw() {
      const c = this.c, wrap = c.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const W = wrap.clientWidth, H = wrap.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const d = this.data;
      const padL = 8, padR = 58, padT = 10, padB = 20;
      if (!d || d.length < 2) {
        g.fillStyle = '#4d5765'; g.font = '12px Inter, sans-serif'; g.textAlign = 'center';
        g.fillText('Equity curve appears after the first few seconds of trading', W / 2, H / 2); return;
      }
      let min = Infinity, max = -Infinity;
      for (const [, v] of d) { if (v < min) min = v; if (v > max) max = v; }
      min = Math.min(min, this.base); max = Math.max(max, this.base);
      const span = Math.max(max - min, max * 0.002, 1e-6);
      min -= span * 0.12; max += span * 0.12;
      const t0 = d[0][0], t1 = d[d.length - 1][0];
      const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
      const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
      const last = d[d.length - 1][1];
      const up = last >= this.base;
      const col = up ? '#19f08c' : '#ff4d6a';

      // grid + y labels
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1; g.fillStyle = '#4d5765'; g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const v = min + ((max - min) * i) / 4, yy = Math.round(y(v)) + 0.5;
        g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
        g.fillText(v.toFixed(v >= 100 ? 1 : 3), W - padR + 6, yy + 3);
      }
      // x labels
      g.textAlign = 'center';
      for (let i = 0; i <= 3; i++) {
        const t = t0 + ((t1 - t0) * i) / 3;
        g.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), Math.min(W - padR - 20, Math.max(24, x(t))), H - 5);
      }
      // baseline (starting equity)
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,.18)';
      g.beginPath(); g.moveTo(padL, y(this.base)); g.lineTo(W - padR, y(this.base)); g.stroke(); g.setLineDash([]);

      // area
      const grad = g.createLinearGradient(0, padT, 0, H - padB);
      grad.addColorStop(0, up ? 'rgba(25,240,140,.28)' : 'rgba(255,77,106,.25)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.beginPath(); g.moveTo(x(d[0][0]), y(d[0][1]));
      for (const [t, v] of d) g.lineTo(x(t), y(v));
      g.lineTo(x(t1), H - padB); g.lineTo(x(t0), H - padB); g.closePath(); g.fillStyle = grad; g.fill();
      // line
      g.beginPath(); g.moveTo(x(d[0][0]), y(d[0][1]));
      for (const [t, v] of d) g.lineTo(x(t), y(v));
      g.strokeStyle = col; g.lineWidth = 2; g.shadowColor = col; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
      // last point
      g.beginPath(); g.arc(x(t1), y(last), 3.5, 0, Math.PI * 2); g.fillStyle = col; g.fill();
      g.fillStyle = col; g.fillRect(W - padR + 2, y(last) - 8, padR - 4, 16);
      g.fillStyle = '#03140b'; g.textAlign = 'left'; g.font = '600 10px "JetBrains Mono", monospace';
      g.fillText(last.toFixed(3), W - padR + 5, y(last) + 3.5);

      // hover crosshair
      if (this.hover != null) {
        const tx = t0 + ((this.hover - padL) / (W - padL - padR)) * (t1 - t0);
        let lo = 0, hi = d.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (d[m][0] < tx) lo = m + 1; else hi = m; }
        const [pt, pv] = d[lo];
        const px = x(pt), py = y(pv);
        g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.moveTo(px, padT); g.lineTo(px, H - padB); g.stroke();
        g.beginPath(); g.arc(px, py, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        const chg = ((pv / this.base) - 1) * 100;
        this.tip.innerHTML = `${new Date(pt).toLocaleTimeString()}<br><b>${pv.toFixed(4)} SOL</b> · $${(pv * (this.usd || 0)).toFixed(0)}<br><span style="color:${chg >= 0 ? '#19f08c' : '#ff4d6a'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
        this.tip.style.display = 'block';
        this.tip.style.left = Math.min(W - 140, Math.max(0, px + 10)) + 'px';
        this.tip.style.top = Math.max(0, py - 50) + 'px';
      }
    }
  }
  window.EquityChart = EquityChart;
})();
