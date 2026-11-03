// Strategist + Researcher agents. They never trade directly: every idea (Critic patch,
// genetic mutation, crossover, fresh research, or LLM proposal) must beat its parent in a
// backtest on recorded market tape, generalize out-of-sample, and survive a stress test
// (3x latency, 20% failed txs, higher fees) before it is promoted to paper trading.
import { PARAM_SPACE, makeStrategy, normalizeParams, diffParams, SEED_STRATEGIES, BASE_PARAMS } from '../core/strategy.js';
import { applyAdjustments, consolidate } from './critic.js';
import { STRESS_EXEC } from '../learn/backtest.js';

const NAMES = ['Phantom', 'Vulture', 'Sentinel', 'Cobra', 'Falcon', 'Kraken', 'Nova', 'Raptor', 'Specter', 'Titan', 'Viper', 'Wraith', 'Onyx', 'Halo', 'Comet'];
const STYLES = ['Sniper', 'Rider', 'Tracker', 'Hunter', 'Scalper', 'Holder'];

export class Strategist {
  constructor({ rng, backtests, llm = null, memory = null, startingSol = 10, maxActive = 6, minActive = 3 }) {
    Object.assign(this, { rng, backtests, llm, memory, startingSol, maxActive, minActive });
  }

  mutate(s, scale = 0.18, rate = 0.3) {
    const p = { ...s.params };
    const keys = Object.keys(PARAM_SPACE);
    let changed = 0;
    for (const k of keys) {
      if (!this.rng.chance(rate)) continue;
      const sp = PARAM_SPACE[k];
      if (sp.int && sp.max <= 3) p[k] = this.rng.chance(0.5) ? Math.max(sp.min, p[k] - 1) : Math.min(sp.max, p[k] + 1);
      else p[k] = p[k] + this.rng.gauss() * scale * (sp.max - sp.min) * 0.5;
      changed++;
    }
    if (!changed) { const k = this.rng.pick(keys); const sp = PARAM_SPACE[k]; p[k] = p[k] + this.rng.gauss() * scale * (sp.max - sp.min) * 0.5; }
    return makeStrategy({ name: s.name, family: s.family, archetype: s.archetype, thesis: s.thesis, params: normalizeParams(p),
      gen: s.gen + 1, parent: s.id, origin: 'mutation' });
  }

  crossover(a, b) {
    const p = {};
    for (const k of Object.keys(PARAM_SPACE)) p[k] = this.rng.chance(0.5) ? a.params[k] : b.params[k];
    const wa = a.name.split(' ')[0], wb = b.name.split(' ')[0];
    const name = wa === wb ? `${wa} Hybrid` : `${wa} × ${wb}`.replace(/ × .* × .*/, ' Hybrid');
    return makeStrategy({ name, archetype: 'hybrid',
      thesis: `Hybrid of "${a.name}" and "${b.name}".`, params: p, gen: Math.max(a.gen, b.gen) + 1, parent: a.id, origin: 'crossover' });
  }

  /** Heuristic research: build a new strategy biased by what the memory says kills us. */
  research() {
    const causes = this.memory?.data.causeCounts || {};
    const wins = this.memory?.data.winTags || {};
    const seed = this.rng.pick(SEED_STRATEGIES);
    const p = { ...BASE_PARAMS, ...seed.params };
    const notes = [];
    const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
    if (top.includes('dead_coin')) { p.minVel10 += 3; p.minUniqueBuyers += 6; notes.push('demand stronger proof of life'); }
    if (top.includes('dev_rug')) { p.maxDevHoldPct = Math.min(p.maxDevHoldPct, 5); p.entryDelaySec += 5; notes.push('smaller dev bags, longer observation'); }
    if (top.includes('bundle_dump')) { p.maxBundlePct = Math.min(p.maxBundlePct, 4); notes.push('near-zero bundle tolerance'); }
    if (top.includes('bought_top')) { p.maxRunupPct *= 0.6; notes.push('avoid chasing run-ups'); }
    if (top.includes('stop_too_tight')) { p.stopLossPct += 5; notes.push('wider stops'); }
    if (top.includes('wash_pump')) { p.minUniqueBuyers += 8; notes.push('filter recycled-wallet pumps'); }
    if ((wins.whale_backed || 0) >= (wins.broad_base || 0)) { p.minWhaleSol30 = Math.max(p.minWhaleSol30, this.rng.range(2, 8)); p.whaleTrailBonusPct = this.rng.range(10, 25); notes.push('follow heavy SOL buys and hold while whales add'); }
    else { p.minUniqueBuyers += 10; notes.push('favor broad organic buyer base'); }
    for (const k of Object.keys(PARAM_SPACE)) if (this.rng.chance(0.2)) { const sp = PARAM_SPACE[k]; p[k] += this.rng.gauss() * 0.15 * (sp.max - sp.min); }
    const name = `${this.rng.pick(NAMES)} ${this.rng.pick(STYLES)}`;
    return makeStrategy({ name, archetype: 'research', thesis: `Research from ${Object.values(causes).reduce((a, b) => a + b, 0)} autopsies: ${notes.join('; ')}.`,
      params: p, gen: 1, origin: 'research' });
  }

  /** Ask the LLM (Grok / Claude) for a strategy. Output is untrusted: it is clamped + backtested like any other idea. */
  async researchLLM(context) {
    if (!this.llm?.enabled) return null;
    const space = Object.fromEntries(Object.entries(PARAM_SPACE).map(([k, v]) => [k, [v.min, v.max]]));
    const sys = 'You are the Researcher on a Pump.fun paper-trading desk. You design entry/exit parameter sets. Reply with ONLY a JSON object: {"name": string, "thesis": string, "params": {..}}. Use only keys from the parameter space and stay inside the ranges.';
    const user = JSON.stringify({ parameterSpace: space, ...context });
    const out = await this.llm.json(sys, user);
    if (!out?.params) return null;
    return makeStrategy({ name: String(out.name || 'LLM Idea').slice(0, 28), archetype: 'llm', thesis: String(out.thesis || '').slice(0, 300),
      params: out.params, gen: 1, origin: `llm:${this.llm.provider}` });
  }

  /** Critic-driven rewrite of one strategy, validated by backtest. */
  async patch(strategy, autopsies, tape, creatorRugs) {
    const plan = consolidate(autopsies);
    if (!plan.adjust.length) return { promoted: false, reason: 'no actionable adjustments', plan };
    const params = applyAdjustments(strategy.params, plan.adjust);
    const changes = diffParams(strategy.params, params);
    if (!changes.length) return { promoted: false, reason: 'adjustments already at limits', plan };
    const cand = makeStrategy({ name: strategy.name, family: strategy.family, archetype: strategy.archetype, thesis: strategy.thesis,
      params, gen: strategy.gen + 1, parent: strategy.id, origin: 'critic-patch' });
    const spanMin = tape.length ? (tape[tape.length - 1].ts - tape[0].ts) / 60000 : 0;
    if (spanMin < 8) return { promoted: true, candidate: cand, changes, plan, validated: false, reason: `tape only ${spanMin.toFixed(1)} min — adopted provisionally` };
    const opts = { startingSol: this.startingSol, creatorRugs };
    const { results } = await this.backtests.run(tape, [{ tag: 'base', strategy, opts }, { tag: 'cand', strategy: cand, opts }]);
    const base = results.find((r) => r.tag === 'base'), c = results.find((r) => r.tag === 'cand');
    if (!base || !c || base.error || c.error) return { promoted: false, reason: 'backtest error', plan };
    const better = c.fitAll > base.fitAll + 1e-6 || (c.all.pnl >= base.all.pnl && c.all.maxDD <= base.all.maxDD && c.all.n > 0);
    return { promoted: better, candidate: cand, changes, plan, validated: true, base, cand: c,
      reason: better ? 'beat parent in backtest' : `rejected: patch scored ${c.fitAll.toFixed(3)} vs parent ${base.fitAll.toFixed(3)}` };
  }

  /** Full evolution cycle over the active population. */
  async evolve(active, tape, { liveStats = new Map(), creatorRugs = {}, llmContext = null } = {}) {
    const opts = { startingSol: this.startingSol, creatorRugs };
    const jobs = [];
    for (const s of active) {
      jobs.push({ tag: `base:${s.id}`, strategy: s, opts });
      for (let i = 0; i < 3; i++) jobs.push({ tag: `mut:${s.id}`, strategy: this.mutate(s, i === 0 ? 0.08 : 0.2), opts });
    }
    const sorted = [...active].sort((a, b) => (liveStats.get(b.id)?.pnl || 0) - (liveStats.get(a.id)?.pnl || 0));
    if (sorted.length >= 2) jobs.push({ tag: 'cross', strategy: this.crossover(sorted[0], sorted[1]), opts });
    jobs.push({ tag: 'research', strategy: this.research(), opts });
    let llmIdea = null;
    try { llmIdea = llmContext ? await this.researchLLM(llmContext) : null; } catch { llmIdea = null; }
    if (llmIdea) jobs.push({ tag: 'research', strategy: llmIdea, opts });

    const t0 = Date.now();
    const { results } = await this.backtests.run(tape, jobs);
    const byTag = (pfx) => results.filter((r) => r.tag.startsWith(pfx) && !r.error);
    const stratOf = (r) => jobs.find((j) => j.strategy.id === r.id)?.strategy;

    const promotions = [];
    const baseFit = new Map();
    for (const s of active) {
      const base = results.find((r) => r.tag === `base:${s.id}`);
      if (!base || base.error) continue;
      baseFit.set(s.id, base);
      const muts = byTag(`mut:${s.id}`).filter((m) => m.fitIS > base.fitIS && m.fitOOS >= base.fitOOS && m.oos.n >= 1 && m.all.pnl > base.all.pnl);
      muts.sort((a, b) => (b.fitIS + b.fitOOS) - (a.fitIS + a.fitOOS));
      if (muts[0]) promotions.push({ parent: s, child: stratOf(muts[0]), before: base, after: muts[0] });
    }
    // Stress test every promotion candidate before it may trade.
    const stressJobs = promotions.map((p) => ({ tag: `stress:${p.child.id}`, strategy: p.child, opts: { ...opts, exec: STRESS_EXEC } }));
    const newcomers = [...byTag('cross'), ...byTag('research')].sort((a, b) => b.fitAll - a.fitAll);
    const fits = [...baseFit.values()].map((b) => b.fitAll).sort((a, b) => a - b);
    const median = fits.length ? fits[Math.floor(fits.length / 2)] : -Infinity;
    const worst = fits.length ? fits[0] : -Infinity;
    const newcomer = newcomers.find((n) => n.fitAll > Math.max(median, 0) && n.all.n >= 4);
    if (newcomer) stressJobs.push({ tag: `stress:${newcomer.id}`, strategy: stratOf(newcomer), opts: { ...opts, exec: STRESS_EXEC } });
    const stress = stressJobs.length ? (await this.backtests.run(tape, stressJobs)).results : [];
    const passes = (id) => {
      const r = stress.find((x) => x.id === id);
      return r && !r.error && r.all.maxDD <= this.startingSol * 0.1 && r.all.pnl > -this.startingSol * 0.05 ? r : null;
    };
    const accepted = [], rejected = [];
    for (const p of promotions) { const st = passes(p.child.id); (st ? accepted : rejected).push({ ...p, stress: st || stress.find((x) => x.id === p.child.id) }); }
    let adopt = null;
    if (newcomer) { const st = passes(newcomer.id); if (st) adopt = { strategy: stratOf(newcomer), result: newcomer, stress: st }; }

    // Retirement: live losers whose backtest also says they are broken.
    const retire = [];
    for (const s of active) {
      const live = liveStats.get(s.id);
      const bt = baseFit.get(s.id);
      if (live && live.n >= 12 && live.pnl < 0 && bt && bt.fitAll < 0 && !accepted.find((a) => a.parent.id === s.id)) retire.push({ strategy: s, live, bt });
    }
    const activeAfter = active.length - retire.length + (adopt ? 1 : 0);
    if (activeAfter > this.maxActive && adopt) {
      const worstS = [...baseFit.entries()].sort((a, b) => a[1].fitAll - b[1].fitAll)[0];
      const ws = active.find((s) => s.id === worstS?.[0]);
      if (ws && !retire.find((r) => r.strategy.id === ws.id) && adopt.result.fitAll > worst) retire.push({ strategy: ws, bt: worstS[1], replaced: true });
      else adopt = null;
    }
    while (active.length - retire.length + (adopt ? 1 : 0) < this.minActive && retire.length) retire.pop();
    return { accepted, rejected, adopt, retire, baseFit, ms: Date.now() - t0, candidates: jobs.length - active.length };
  }
}
