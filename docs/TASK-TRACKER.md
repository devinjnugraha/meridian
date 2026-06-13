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

| # | Task | Status | Commit | Notes |
|---|------|--------|--------|-------|
| P1-1 | Fix single-factor scoring in screening | **Done** | `195bf8f` | screening.js: normalize feeTvl/organic/volume/holders/liquidity to weighted 0-10 scale |
| P1-2 | Fix volatility weight direction (Math.abs bug) | **Done** | `195bf8f` | signal-weights.js: replaced Math.abs with lossMean-winMean for correct direction |
| P1-3 | Fix position-level vs pool-level fee rate comparison | Pending | | state.js: store pool-level rate alongside position rate for decay comparison |
| P1-4 | Lower default stop-loss, enable IL stop | **Done** | `46f99c5` | config.js: stopLossPct -50→-25, dynamicILStop false→true |
| P1-5 | Align prompt with config values | **Done** | `195bf8f` | prompt.js: replaced hardcoded stop-loss/TP/trailing with config.management refs |
| P1-6 | Add portfolio-level circuit breaker | Pending | | config.js + index.js: maxDailyLossSol, maxConsecutiveLosses |
| P1-7 | Fix lesson scorer strategy match giving free +0.5 | **Done** | `195bf8f` | lesson-scorer.js: only full score when pool strategy matches lesson strategy |
| P1-8 | Fix confirmed exits expiring silently after 30s | Pending | | state.js: re-queue with one retry before clearing |
| P1-9 | Fix close result missing SOL fields for tracked positions | **Done** | `195bf8f` | dlmm.js: added initial_sol, withdrawn_sol, fees_sol to tracked close return |

## P2 — Medium Impact

| # | Task | Status | Commit | Notes |
|---|------|--------|--------|-------|
| P2-1 | Fix take-profit firing before trailing TP | **Done** | `195bf8f` | state.js: added !pos.trailing_active guard to fixed TP check |
| P2-2 | Add floating-point precision fix for token amounts | **Done** | `195bf8f` | dlmm.js: Math.floor→Math.round + .toString() for BN construction |
| P2-3 | Fix fee/TVL fallback using raw windowed values | Pending | | screening.js: annualize fallback when API returns 0 |
| P2-4 | Make 0-5% PnL trades generate lessons | **Done** | `195bf8f` | lessons.js: confidence=0.3, fall through instead of returning null |
| P2-5 | Fix lesson scorer inconsistent scales | Pending | | lesson-scorer.js: ±25 vs ±0.25; extract shared fn |
| P2-6 | Add PnL sanity check bypass for extreme losses | **Done** | `195bf8f` | state.js: stop-loss fires with 1.5x stricter threshold when suspicious |
| P2-7 | Add recompound price check | Pending | | index.js: skip recompound if token dropped >50% from entry |
| P2-8 | Fix pool cache cleared on fixed timer | Pending | | dlmm.js: per-entry TTL instead of wholesale clear |
| P2-9 | Unhide auto-swap failure notification | **Done** | `195bf8f` | executor.js: uncommented notifySwapFailed on auto-swap skip |
| P2-10 | Fix lesson evolution threshold too aggressive | **Done** | `195bf8f` | lessons.js: MIN_EVOLVE_POSITIONS 5→15, MAX_CHANGE_PER_STEP 20%→30% |

## General Improvements (Enhancement)

| # | Task | Status | Commit | Notes |
|---|------|--------|--------|-------|
| GEN-1 | Add transaction fee accounting to PnL | Pending | | state.js/dlmm.js: track deploy+close+recompound tx fees |
| GEN-2 | Add per-token concentration enforcement | Pending | | executor.js: hard-block deploy if >30% portfolio in single token |
| GEN-3 | Add wash trading heuristic fallback | Pending | | screening.js: local heuristic when OKX API fails |
| GEN-4 | Widen volatility match tolerance in lesson scorer | **Done** | `195bf8f` | lesson-scorer.js: ±1/±2 → ±2/±4 |

---

## Summary

- **Done:** 19 (all P0, most P1/P2, GEN-4)
- **Remaining:** 10 (P1-3, P1-6, P1-8, P2-3, P2-5, P2-7, P2-8, GEN-1, GEN-2, GEN-3)
