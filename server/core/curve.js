// Pump.fun bonding curve math (constant product on virtual reserves).
// All amounts are in UI units: SOL and whole tokens (6-decimal tokens / 1e6).

export const TOTAL_SUPPLY = 1_000_000_000;
export const INITIAL_VSOL = 30;
export const INITIAL_VTOK = 1_073_000_000;
export const GRADUATION_REAL_SOL = 85; // curve completes around ~85 real SOL
export const GRADUATION_VSOL = INITIAL_VSOL + GRADUATION_REAL_SOL;
// Protocol + creator fee charged on each bonding-curve trade (approximate).
export const PUMP_FEE = 0.0125;

export const price = (vSol, vTok) => vSol / vTok;
export const mcapSol = (vSol, vTok) => (vSol / vTok) * TOTAL_SUPPLY;
export const INITIAL_MCAP = mcapSol(INITIAL_VSOL, INITIAL_VTOK);

/** Tokens received for solIn SOL (fee taken from input). */
export function buyQuote(vSol, vTok, solIn, fee = PUMP_FEE) {
  const net = solIn * (1 - fee);
  const k = vSol * vTok;
  return vTok - k / (vSol + net);
}

/** SOL received (after fee) for selling tokIn tokens. */
export function sellQuote(vSol, vTok, tokIn, fee = PUMP_FEE) {
  const k = vSol * vTok;
  const gross = vSol - k / (vTok + tokIn);
  return gross * (1 - fee);
}

/** Apply a trade to reserves, returning the new reserves. */
export function applyBuy(vSol, vTok, solIn, fee = PUMP_FEE) {
  const tokens = buyQuote(vSol, vTok, solIn, fee);
  return { vSol: vSol + solIn * (1 - fee), vTok: vTok - tokens, tokens };
}

export function applySell(vSol, vTok, tokIn, fee = PUMP_FEE) {
  const k = vSol * vTok;
  const newVTok = vTok + tokIn;
  const newVSol = k / newVTok;
  const gross = vSol - newVSol;
  return { vSol: newVSol, vTok: newVTok, sol: gross * (1 - fee) };
}
