// Long-term team memory: rug-dev blacklist, loss-cause statistics, lessons, strategy lineage.
// Persisted to data/memory.json plus a human-readable Markdown ledger (data/ledger.md).
import fs from 'node:fs';
import path from 'node:path';

export class Memory {
  constructor(dir, { persist = true } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.file = path.join(dir, 'memory.json');
    this.ledgerFile = path.join(dir, 'ledger.md');
    this.data = { creatorRugs: {}, causeCounts: {}, winTags: {}, lessons: [], lineage: [], strategies: [], createdAt: Date.now() };
    if (persist) {
      fs.mkdirSync(dir, { recursive: true });
      try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* fresh memory */ }
      if (!fs.existsSync(this.ledgerFile)) fs.writeFileSync(this.ledgerFile, '# GrokDesk Strategy Ledger\n\nEvery loss autopsy, rewrite, promotion and retirement is logged here.\n\n');
    }
    this.dirty = false;
  }

  creatorRugs(creator) { return this.data.creatorRugs[creator] || 0; }
  markRugger(creator) { if (!creator) return; this.data.creatorRugs[creator] = (this.data.creatorRugs[creator] || 0) + 1; this.dirty = true; }

  addLesson(lesson) {
    this.data.lessons.push(lesson);
    if (this.data.lessons.length > 1500) this.data.lessons.splice(0, 500);
    this.data.causeCounts[lesson.cause] = (this.data.causeCounts[lesson.cause] || 0) + 1;
    this.dirty = true;
  }
  addWin(tags) { for (const t of tags) this.data.winTags[t] = (this.data.winTags[t] || 0) + 1; this.dirty = true; }
  addLineage(entry) { this.data.lineage.push(entry); if (this.data.lineage.length > 1000) this.data.lineage.splice(0, 200); this.dirty = true; }

  ledger(title, lines, ts = Date.now()) {
    if (!this.persist) return;
    const when = new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
    const body = (Array.isArray(lines) ? lines : [lines]).map((l) => `- ${l}`).join('\n');
    fs.appendFile(this.ledgerFile, `### ${when} · ${title}\n${body}\n\n`, () => {});
  }

  recentLedger(n = 40) {
    return this.data.lessons.slice(-n).reverse();
  }

  save(force = false) {
    if (!this.persist || (!this.dirty && !force)) return;
    this.dirty = false;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
