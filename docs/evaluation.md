# GrokDesk strategy evaluation

Generated 2026-11-03 22:13 UTC by `node scripts/evaluate.js 6 5` (322s).

> **Synthetic market only.** These numbers come from the built-in Pump.fun simulator, not real on-chain data. They show
> whether the learning loop picks better rules than the starting ones; they do **not** predict live profit.
> Sizing is fixed at ≤2% of the 10 SOL start (0.2 SOL per trade max), no compounding.

## 1. Training (6h session, full learning loop)

| Hour | Equity (SOL) | Trades | Hour PnL | Win rate |
|---|---|---|---|---|
| 1 | 18.06 | 221 | +7.95 | 56% |
| 2 | 32.83 | 192 | +14.46 | 71% |
| 3 | 48.33 | 244 | +15.44 | 68% |
| 4 | 63.95 | 262 | +15.70 | 74% |
| 5 | 71.58 | 211 | +7.96 | 60% |

Learning: 91 critic patches, 22 evolution cycles, 75 promotions, 74 rejected changes, 5 retired, 82 rug creators blacklisted.

Loss causes diagnosed by the Critic:

| Cause | Count |
|---|---|
| noise | 88 |
| dead_coin | 80 |
| dev_rug | 75 |
| stop_too_tight | 44 |
| gave_back_gains | 39 |
| bought_top | 34 |
| bundle_dump | 30 |
| falling_knife | 26 |
| wash_pump | 19 |
| concentrated | 10 |

## 2. Out-of-sample test (5 unseen 1h sessions, normal + stress execution)

Stress = 1.2s latency, 20% failed transactions, 2× fees. "Bad-coin entries" = share of buys into coins that were
actually rugs, bundles, pump & dumps, fakes ("faders") or dead.

| # | Strategy | Trades | Win | PnL (SOL) | PF | Max DD | Avg trade | Green sessions | Stress PnL | Bad-coin entries |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Lightning × Safe g12 (learned) | 741 | 74% | +84.71 | 12.89 | 0.18 | +59.2% | 5/5 | +67.82 | 57% |
| 2 | Momentum Hybrid g11 (learned) | 892 | 73% | +77.52 | 11.58 | 0.17 | +47.8% | 5/5 | +57.97 | 62% |
| 3 | Safe × Momentum g11 (learned) | 828 | 77% | +74.68 | 15.68 | 0.14 | +54.9% | 5/5 | +59.09 | 59% |
| 4 | Safe × Momentum g12 (learned) | 707 | 77% | +65.10 | 15.15 | 0.14 | +56.1% | 5/5 | +49.88 | 55% |
| 5 | Momentum × Whale g17 (learned) | 645 | 73% | +65.03 | 16.39 | 0.13 | +65.6% | 5/5 | +51.38 | 58% |
| 6 | Momentum × Safe g11 (learned) | 688 | 73% | +60.12 | 12.80 | 0.17 | +54.0% | 5/5 | +50.60 | 63% |
| 7 | Safe × Momentum g12 (learned) | 683 | 78% | +59.86 | 16.45 | 0.13 | +54.1% | 5/5 | +48.24 | 55% |
| 8 | Momentum × Lightning g12 (learned) | 695 | 72% | +51.50 | 10.96 | 0.15 | +52.9% | 5/5 | +41.69 | 56% |
| 9 | Safe Scout g13 (learned) | 620 | 72% | +39.38 | 9.99 | 0.14 | +46.7% | 5/5 | +32.45 | 55% |
| 10 | Momentum Rider g1 (seed) | 708 | 61% | +34.46 | 5.34 | 0.22 | +32.3% | 5/5 | +27.83 | 65% |
| 11 | Safe Scout g1 (seed) | 372 | 71% | +25.05 | 9.83 | 0.14 | +44.7% | 5/5 | +18.19 | 49% |
| 12 | Whale Follower g1 (seed) | 561 | 42% | +18.06 | 2.57 | 0.55 | +21.4% | 5/5 | +11.60 | 74% |
| 13 | Lightning Snipe g1 (seed) | 801 | 40% | +11.50 | 2.38 | 0.29 | +9.5% | 5/5 | +6.62 | 86% |
| 14 | Graduation Hunter g1 (seed) | 211 | 44% | +1.54 | 1.47 | 0.32 | +4.9% | 5/5 | +1.21 | 59% |

## 3. Best sniping strategy: Lightning × Safe g12 (learned)

Hybrid of "Lightning Snipe" and "Safe Scout".

What it bought, by true coin type (unseen sessions):

| Coin type | Trades | PnL (SOL) |
|---|---|---|
| fader | 283 | +29.60 |
| slow_bleed | 192 | +10.49 |
| runner | 126 | +38.59 |
| rug_dev | 115 | +7.50 |
| pump_dump | 25 | -1.48 |

Rules:

| | |
|---|---|
| Entry timing | wait 17.4s after launch, never after 344s |
| Market cap window | 28.5–74.7 SOL |
| Proof of life (anti-dead-coin) | ≥ 20 unique buyers, ≥ 5.3 trades / 10s, last trade ≤ 8.1s ago, buy/sell SOL ≥ 1.1, net inflow ≥ -0.3 SOL / 30s |
| Safety | dev bag ≤ 8%, dev sold ≤ 10%, bundle ≤ 5.7%, top-10 ≤ 36.9%, socials optional, known ruggers ≤ 0 |
| Don't chase | run-up ≤ 126.3%, ≤ 22.7% below local peak |
| Whale logic | whale = single buy ≥ 1 SOL; need ≥ 0 SOL of whale buys in 30s; while whales buy, trailing stop +14.3% and hold up to 2× longer (51.1s window) |
| Size | 1.9% of equity (hard cap 2%) |
| Exits | stop −23.9%, take 40.6% off at +114.8%, trailing 16.7%, exit if no trades for 9.4s, sell-pressure ratio 3.2, dev sells ≥ 15% → exit now, max hold 120s |

Full parameter set: [`docs/best-strategy.json`](best-strategy.json).
