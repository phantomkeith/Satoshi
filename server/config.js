import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' && Number.isFinite(+env[k]) ? +env[k] : d);

export const config = {
  port: num('PORT', 8787),
  host: env.HOST || '0.0.0.0',
  // sim | pumpportal | rpc   (rpc = direct Solana logsSubscribe on the Pump.fun program)
  feedMode: env.FEED_MODE || 'sim',
  pumpPortalWs: env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data',
  solanaWs: env.SOLANA_WS_URL || '',      // e.g. wss://mainnet.helius-rpc.com/?api-key=...
  solanaHttp: env.SOLANA_RPC_URL || '',
  fetchMetadata: env.FETCH_METADATA !== '0',
  startingSol: num('STARTING_SOL', 10),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  recordTape: env.RECORD_TAPE !== '0',
  tapeMax: num('TAPE_MAX_EVENTS', 400_000),
  evolveEverySec: num('EVOLVE_EVERY_SEC', 600),
  evolveWindowMin: num('EVOLVE_WINDOW_MIN', 60),
  minTapeMin: num('MIN_TAPE_MIN', 10),
  patchAfterLosses: num('PATCH_AFTER_LOSSES', 3),
  patchCooldownSec: num('PATCH_COOLDOWN_SEC', 300),
  exec: {
    latencyMs: num('PAPER_LATENCY_MS', 400),
    failRate: num('PAPER_FAIL_RATE', 0.06),
    priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0003),
    jitoTipSol: num('JITO_TIP_SOL', 0.0005),
  },
  simLaunchesPerMin: num('SIM_LAUNCHES_PER_MIN', 14),
  llm: {
    xaiKey: env.XAI_API_KEY || '', xaiModel: env.XAI_MODEL || 'grok-4',
    anthropicKey: env.ANTHROPIC_API_KEY || '', anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  },
};
