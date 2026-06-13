# Meridian Improvement Task Tracker

Source spec: `docs/IMPROVEMENTS.md`
Branch: `experimental-custom`
Last updated: 2026-06-13

---

## P0 — Critical (Direct Money Loss)

| # | Task | Status | Commit | Notes |
|---|------|--------|--------|-------|
| P0-1 | Fix rebalance: absolute bin IDs treated as relative offsets | **Done** | `46f99c5` | executor.js: convert abs→rel via getActiveBin(); definitions.js: clarify descriptions |
| P0-2 | Fix PnL derivation double-counting fees | **Done** | `46f99c5` | dlmm.js: removed `+ fees` from deriveOpenPnlPct formula |
| P0-3 | Fix NaN/Infinity accepted as closed PnL | **Done** | `46f99c5` | dlmm.js: shouldRejectClosedPnl now returns true for non-finite |
| P0-4 | Fix hardcoded 10% slippage — make configurable | **Done** | `46f99c5` | config.js: deploySlippageBps/recompoundSlippageBps (3% default); dlmm.js + wallet.js: use config |
| P0-5 | Fix wide-range deploy retry creating orphan positions | **Done** | `46f99c5` | dlmm.js: Keypair.generate() moved inside retry loop |
| P0-6 | Don't discard rug-pull losses — learn from them | **Done** | `46f99c5` | lessons.js: cap at -90% and fall through to lesson generation |

## P1 — High Impact

| # | Task | Status | Files | Notes |
|---|------|--------|-------|-------|
| P1-1 | Fix single-factor scoring in screening | Pending | `tools/screening.js` | feeTvl*1000 dominates; normalize each factor to 0-10 with weights |
| P1-2 | Fix volatility weight direction (Math.abs bug) | Pending | `signal-weights.js` | Math.abs makes lift always positive; use lossMean - winMean |
| P1-3 | Fix position-level vs pool-level fee rate comparison | Pending | `state.js` | Store pool-level rate alongside position rate for decay comparison |
| P1-4 | Lower default stop-loss, enable IL stop | **Done** | `config.js` | stopLossPct: -50→-25, dynamicILStop: false→true |
| P1-5 | Align prompt with config values | Pending | `prompt.js` | Replace hardcoded stop-loss/TP/trailing values with config refs |
| P1-6 | Add portfolio-level circuit breaker | Pending | `config.js`, `index.js` | maxDailyLossSol, maxConsecutiveLosses; gate deploy path |
| P1-7 | Fix lesson scorer strategy match giving free +0.5 | Pending | `lesson-scorer.js` | Only score full when strategies match, not unconditionally |
| P1-8 | Fix confirmed exits expiring silently after 30s | Pending | `state.js` | Re-queue with one retry (extend 60s) before clearing |
| P1-9 | Fix close result missing SOL fields for tracked positions | Pending | `tools/dlmm.js` | Add initial_sol, withdrawn_sol, fees_sol to tracked path return |

## P2 — Medium Impact

| # | Task | Status | Files | Notes |
|---|------|--------|-------|-------|
| P2-1 | Fix take-profit firing before trailing TP | Pending | `state.js` | Add `!pos.trailing_active` guard to fixed TP check |
| P2-2 | Add floating-point precision fix for token amounts | Pending | `tools/dlmm.js` | Math.floor→Math.round + .toString() for BN construction |
| P2-3 | Fix fee/TVL fallback using raw windowed values | Pending | `tools/screening.js` | Annualize fallback calculation when API returns 0 |
| P2-4 | Make 0-5% PnL trades generate lessons | Pending | `lessons.js` | Set confidence=0.3, fall through instead of returning null |
| P2-5 | Fix lesson scorer inconsistent scales | Pending | `lesson-scorer.js` | scorePoolByLessons ±25 vs scorePool ±0.25; extract shared fn |
| P2-6 | Add PnL sanity check bypass for extreme losses | Pending | `state.js` | Allow stop-loss with 1.5x stricter threshold when suspicious |
| P2-7 | Add recompound price check | Pending | `index.js` | Skip recompound if token dropped >50% from entry |
| P2-8 | Fix pool cache cleared on fixed timer | Pending | `tools/dlmm.js` | Per-entry TTL (5min) instead of wholesale clear every 15min |
| P2-9 | Unhide auto-swap failure notification | Pending | `tools/executor.js` | Uncomment notifySwapFailed call on swap skip |
| P2-10 | Fix lesson evolution threshold too aggressive | Pending | `lessons.js` | MIN_EVOLVE_POSITIONS 5→15; cap threshold change at 30% |

## General Improvements (Enhancement)

| # | Task | Status | Files | Notes |
|---|------|--------|-------|-------|
| GEN-1 | Add transaction fee accounting to PnL | Pending | `state.js`/`dlmm.js` | Track deploy+close+recompound tx fees, deduct from PnL |
| GEN-2 | Add per-token concentration enforcement | Pending | `tools/executor.js` | Hard-block deploy if >30% portfolio in single token |
| GEN-3 | Add wash trading heuristic fallback | Pending | `tools/screening.js` | Local heuristic when OKX API fails |
| GEN-4 | Widen volatility match tolerance in lesson scorer | Pending | `lesson-scorer.js` | ±1.0/±2.0 → ±2.0/±4.0 |

---

## Summary

- **Done:** 7 (P0-1 through P0-6 + P1-4)
- **Remaining:** 22 (P1: 8, P2: 10, GEN: 4)
