# solMode End-to-End SOL Denomination — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm)
**Owner:** devinjnugraha

## Motivation

`solMode` today is half-implemented. Open-position reporting in `getMyPositions()`
genuinely switches values to SOL (`tools/dlmm.js:664-718` reads `*Native`/`*Sol`
API fields), but the close flow, performance history, and Telegram notifications
do not — they keep USD values while only swapping the symbol to `◎`. Concretely:

- `/close` notification (`index.js:1879`) and the performance summary
  (`index.js:1178,1190`) show USD amounts prefixed with `◎` when `solMode` is on.
- `telegram.js:488` (`notifyClose`) hardcodes `$` and ignores `solMode` entirely.

The user's actual pain point: when SOL/USD pumps, USD-denominated PnL looks green
even though the position gained no real SOL. This both misleads the operator and
biases close/IL/stop decisions away from acting. The goal is that, under
`solMode`, the agent operates purely on SOL values end-to-end so the SOL/USD
price cannot inflate PnL or trigger false signals.

## Scope

**In scope (the management path):** position PnL, value, fees; close, IL-stop,
hard-stop, trailing-TP, and claim decisions; notifications; performance history
and lessons.

**Out of scope:** pool *screening* filters (`minTvl`, `maxTvl`, `minVolume`,
`minMcap`, `maxMcap`). These are passed as USD values directly to the Meteora
pools API query (`tools/screening.js:128-133`) and cannot be reinterpreted as SOL
without a SOL/USD price oracle — which would reintroduce the exact USD-price
dependency this work exists to remove. Deploy math (`deployAmountSol`,
`positionSizePct`, `gasReserve`, `minSolToOpen`) is already SOL-denominated and
unaffected.

## Approach Chosen

**B — First-class SOL fields.** Add explicit `*_sol` fields alongside `*_usd`
everywhere; the reporting/decision layer reads `*_sol` when `solMode` is on,
`*_usd` otherwise. The `*_true_usd` parallel fields added previously become
redundant and are removed.

Rejected alternatives:
- **A — Field-level switching:** keep overloading `*_usd` to hold SOL. Least
  code, but perpetuates the naming landmine that caused the current half-broken
  state.
- **C — Canonical value + unit field:** single `value`/`pnl`/`fees` triplet with
  a `unit` field. Cleanest conceptually but ripples into LLM tool schemas and the
  agent prompt — not worth the churn.

## Data Model

### `getMyPositions()` — `tools/dlmm.js`

Every position payload carries both USD and SOL triples simultaneously.

| Field | Meaning |
|---|---|
| `pnl_usd`, `total_value_usd`, `unclaimed_fees_usd`, `collected_fees_usd`, `pnl_pct` | **Always USD.** Reverts today's `solMode`-switching so the `_usd` suffix is honest again. Sourced from `lpData.*` / `binData.*` USD fields as today. |
| `pnl_sol`, `total_value_sol`, `unclaimed_fees_sol`, `collected_fees_sol`, `pnl_pct_sol` | **Always SOL (new).** Sourced from the same `*Native` / `*Sol` API fields the current switching logic already uses. |
| `*_true_usd` (`total_value_true_usd`, `collected_fees_true_usd`, `pnl_true_usd`, `unclaimed_fees_true_usd`) | **Removed.** Redundant once `*_usd` is always USD. |

PnL percentage basis mirrors the value unit: `pnl_pct` is USD-basis,
`pnl_pct_sol` is SOL-basis. The `reportedPnlPct` / `derivedPnlPct` computations
(`dlmm.js:637-646`) produce both.

### Close result — `tools/dlmm.js close_position`

The SOL accounting is already fetched at `:1177-1179` (`initialSol`, `withdrawnSol`,
`feesSol`). Add:

- `pnl_sol = withdrawnSol + feesSol − initialSol`
- `pnl_pct_sol = initialSol > 0 ? (pnl_sol / initialSol) * 100 : 0`

`pnl_usd` / `pnl_pct` stay USD (from the closed-API or the cached fallback, which
already prefers `*_true_usd` — once those are removed, it falls back to `*_usd`,
which is now always-USD and safe).

`initial_sol`, `withdrawn_sol`, `fees_sol` are already returned — unchanged.

### Performance records — `lessons.js recordPerformance` / `state.json`

Honors the "tag records by unit" decision. Each record stores values in **one**
unit set, declared by a `unit` field:

- New records under `solMode` populate `pnl_sol`, `initial_value_sol`,
  `final_value_sol`, `fees_earned_sol` and set `unit: "sol"`.
- Pre-existing USD records keep `pnl_usd`, `initial_value_usd`, `final_value_usd`,
  `fees_earned_usd` and are read back with `unit` defaulted to `"usd"` for
  back-compat.
- The existing `suspiciousUnitMix` guard (`lessons.js:114-131`) is kept as
  defense-in-depth for legacy records.

### `getPerformanceHistory` — `lessons.js:803`

Unit-aware aggregation:

- Group records by `unit`. Sum each record's own-unit PnL field
  (`pnl_sol` for sol records, `pnl_usd` for usd records) into a unit-neutral
  `total_pnl` field, accompanied by a `unit` field on the returned aggregate
  (replacing today's `total_pnl_usd`). This keeps the aggregate layer honest
  under approach B — no `_usd`-named field holding SOL.
- When `solMode` is active, SOL-unit totals are primary; include a footnote count
  of excluded USD records (e.g. "12 historic USD closes excluded"). Vice-versa
  when `solMode` is off.
- Win-rate uses each record's own-unit PnL sign — remains correct across units.
- `pnl_pct` aggregation stays unit-agnostic (percentages are comparable).
- Consumers reading the old `total_pnl_usd` key (`index.js:1178`) are updated to
  read `total_pnl` + `unit`.

## Decision Logic

Under `solMode`, the decision path reads only `*_sol` / `pnl_pct_sol`. This is
the invariant that guarantees decisions are "not affected by SOL–USDT price."

### `pickMoney(p)` accessor

A single helper (placed in `state.js` or a small shared util) centralizes the
switch so every decision and render site goes through it:

```js
// returns { pnl, totalValue, unclaimedFees, collectedFees, pnlPct, unit }
config.management.solMode
  ? { pnl: p.pnl_sol,            totalValue: p.total_value_sol,
      unclaimedFees: p.unclaimed_fees_sol, collectedFees: p.collected_fees_sol,
      pnlPct: p.pnl_pct_sol,     unit: "sol" }
  : { pnl: p.pnl_usd,            totalValue: p.total_value_usd,
      unclaimedFees: p.unclaimed_fees_usd, collectedFees: p.collected_fees_usd,
      pnlPct: p.pnl_pct,         unit: "usd" }
```

### Sites rewired through `pickMoney(p)`

| Site | File:line | Change |
|---|---|---|
| `computeILMetrics` | `state.js:586` | Read `pnl`, `totalValue`, `unclaimedFees`, `collectedFees` from `pickMoney(p)`. Math is ratio-based, so `ilPct` and `daysToRecover` thresholds (`ilStopMinPct`, `ilRecoveryMaxDays`) need no change. Absolute outputs become SOL-denominated when `solMode`. |
| Hard stop-loss + trailing TP | `getDeterministicCloseRule` | Compare against `pnlPct` from `pickMoney`. |
| Dynamic IL exit check | `updatePnlAndCheckExits` | Derives from `computeILMetrics`, so inherits SOL basis automatically. |
| Claim threshold | `index.js:478` | `unclaimedFees >= minClaimAmount` via `pickMoney`. |

### Config interpretation under `solMode`

- `minClaimAmount` becomes a **SOL** amount. Default will be adjusted (current
  default is USD-sized; a SOL default such as `0.005` is reasonable) and surfaced
  in `setup.js`, the `user-config.example.json` comment, and `CLAUDE.md`.
- Already-SOL keys unaffected: `deployAmountSol`, `gasReserve`, `minSolToOpen`,
  `maxDeployAmount`, `positionSizePct`.
- Screening keys stay USD (out of scope).

## Reporting & Notifications

All render sites route through `pickMoney(p)` so the value and the symbol always
agree.

| Site | File:line | Change |
|---|---|---|
| `formatPositionBlock` | `index.js:1609` | Value/Fees/PnL read from `pickMoney(p)`; `cur` already swaps to `◎`. |
| `formatSummary` | `index.js:1557` | Totals via `pickMoney`. |
| `computeILLine` | `index.js:1585` | Inherits SOL absolutes from `computeILMetrics`; symbol already swaps. No field refs to change. |
| Performance summary | `index.js:1172-1190` | Reads unit-aware `getPerformanceHistory`; renders with `cur`. |
| `/positions`, `/pool`, `/status` | `index.js:1815, 1833, 2256` | Field refs (`p.unclaimed_fees_usd`, etc.) → `pickMoney(p)`. |
| `/close` notification | `index.js:1879` | `result.pnl_usd` → `result.pnl_sol` when `solMode`. |

### `telegram.js notifyClose` (`:471`)

Currently hardcodes `$` and ignores `solMode`. Becomes unit-aware:

- Accept `unit` + `pnlSol` (the function already receives `initialSol`,
  `withdrawnSol`, `feesSol`, `solReceived`).
- Render `PnL: +◎0.012 (5.2%)` when `solMode`, else `+$1.50` as today.
- The existing SOL-received line stays and becomes the primary context under
  `solMode`.

### Agent prompt — `prompt.js`

Small addition: when `solMode` is active, the MANAGER and SCREENER prompts state
"positions are denominated in SOL; reason from `*_sol` fields." This steers the
LLM away from USD values the tool result still exposes for internal accounting.

### Docs / setup

- `setup.js:294` `solMode` row — update description to note end-to-end SOL
  behavior and the `minClaimAmount` flip.
- `user-config.example.json:68` — update inline comment.
- `CLAUDE.md` — add a "solMode (end-to-end SOL)" subsection under Config System
  listing the SOL-denominated keys under `solMode`.

## Error Handling

- Missing SOL data (API returns null `*Native`/`*Sol`): `pickMoney` falls back to
  `null` and renderers show `?` as they do today for missing USD. Decisions that
  require a value (IL, claim) skip the position with a `positions_warn` log,
  matching current behavior on missing USD data.
- Mixed-unit history: protected by the `unit` tag and same-unit aggregation. A
  record missing both `unit` and SOL fields is treated as `unit:"usd"` (legacy).

## Testing

- Unit tests for `pickMoney` (both branches + missing-field fallback).
- Unit tests for `getPerformanceHistory` with mixed-unit records — assert
  same-unit summation and excluded-count footnote.
- Unit test for `recordPerformance` writing a `unit:"sol"` record with SOL fields.
- Unit test for `computeILMetrics` under `solMode` — inputs/outputs in SOL,
  thresholds unchanged.
- Regression: render snapshot of `formatPositionBlock` under `solMode` showing
  `◎` with SOL values (not USD).

## Out of Scope / Future

- Screening in SOL (would need a SOL/USD oracle — deferred by decision).
- Migrating legacy USD history to SOL (not needed; unit-tag handles coexistence).
- `lessons.js evolveThresholds` references wrong config keys (`maxVolatility`,
  `minFeeTvlRatio`) — pre-existing tech debt, unrelated to this work.
