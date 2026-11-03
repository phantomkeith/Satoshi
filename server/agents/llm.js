// Optional LLM brain for the desk. GrokDesk uses xAI Grok when XAI_API_KEY is set, or Claude
// when ANTHROPIC_API_KEY is set. LLM output is ALWAYS treated as an untrusted proposal: it is
// clamped to the parameter space, backtested and stress tested, and it can never bypass the
// hard risk limits. Never on the hot path (sniping decisions are made in-process in ms).
export class LLM {
  constructor({ xaiKey, xaiModel = 'grok-4', anthropicKey, anthropicModel = 'claude-sonnet-5-5', minIntervalMs = 20000 } = {}) {
    this.xaiKey = xaiKey; this.xaiModel = xaiModel;
    this.anthropicKey = anthropicKey; this.anthropicModel = anthropicModel;
    this.minIntervalMs = minIntervalMs; this.last = 0; this.calls = 0; this.errors = 0;
  }
  get enabled() { return !!(this.xaiKey || this.anthropicKey); }
  get provider() { return this.xaiKey ? `grok (${this.xaiModel})` : this.anthropicKey ? `claude (${this.anthropicModel})` : 'off'; }

  async complete(system, user, { maxTokens = 700 } = {}) {
    if (!this.enabled) return null;
    const now = Date.now();
    if (now - this.last < this.minIntervalMs) return null; // rate limit
    this.last = now; this.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      if (this.xaiKey) {
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.xaiKey}` },
          body: JSON.stringify({ model: this.xaiModel, max_tokens: maxTokens, temperature: 0.4,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        });
        if (!r.ok) throw new Error(`xai ${r.status}`);
        const j = await r.json();
        return j.choices?.[0]?.message?.content ?? null;
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`anthropic ${r.status}`);
      const j = await r.json();
      return j.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') ?? null;
    } catch (e) {
      this.errors++; this.lastError = String(e.message || e);
      return null;
    } finally { clearTimeout(timer); }
  }

  async json(system, user) {
    const text = await this.complete(system, user);
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
