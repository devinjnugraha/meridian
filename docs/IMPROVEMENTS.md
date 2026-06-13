# Meridian Bot Profitability Fix Spec

Target repo: `https://github.com/devinjnugraha/meridian` branch `experimental-custom`

Apply fixes in order — P0 first, then P1, then P2. Each fix includes exact file, line range, current code, and what to change it to. Run `node test/*.js` after each P0 fix to verify nothing breaks.

---

## P0 — Critical (Direct Money Loss)

### P0-1. Fix rebalance: absolute bin IDs treated as relative offsets

**File:** `tools/executor.js` lines ~100–127

**Problem:** The tool definition says `new_lower_bin`/`new_upper_bin` are absolute bin IDs. But the handler passes them directly as `bins_below`/`bins_above`, which `deployPosition` in `dlmm.js` treats as **relative offsets from active bin**. A call with bins 8000–8100 creates a 16,100-bin position instead of 100.

**Current code (executor.js ~122-123):**

```js
bins_below: Math.max(0, new_lower_bin),
bins_above: Math.max(0, new_upper_bin),
```

**Fix — convert absolute to relative:**

```js
// Fetch active bin from the pool to convert absolute → relative
const pool = await getPool(poolAddress);
const activeBin = await pool.getActiveBin();
const activeBinId = activeBin.binId;

bins_below: Math.max(0, activeBinId - new_lower_bin),
bins_above: Math.max(0, new_upper_bin - activeBinId),
```

Also update the tool definition in `tools/definitions.js` (~line 1240-1247) to clarify:

```js
// Change description to explicitly state these are ABSOLUTE bin IDs
// that will be converted to relative offsets from the active bin
```

**Verification:** Log the resulting `bins_below` and `bins_above` values — they should be small numbers (typically 5–30), not thousands.

---

### P0-2. Fix PnL derivation double-counting fees

**File:** `tools/dlmm.js` lines ~551–573, function `deriveOpenPnlPct`

**Problem:** The formula is:

```
pnl = balances + unclaimedFees + withdrawals + fees - deposit
```

`fees` = `allTimeFees` (total fees earned, both claimed and unclaimed). But `withdrawals` already includes claimed fees that were withdrawn, and `unclaimedFees` already includes uncollected fees. Adding `fees` on top double-counts all earned fees.

**Current code (~line 572):**

```js
const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
```

**Fix:**

```js
const pnl = balances + unclaimedFees + withdrawals - deposit;
```

Remove the `+ fees` term. The `unclaimedFees` (still in-position) and `withdrawals` (already pulled out, which includes claimed fees) already account for all earned fees.

**Verification:** After fix, compare `deriveOpenPnlPct` results with the Meteora API PnL for a few positions — they should now be closer. The "suspicious PnL" flags should reduce significantly.

---

### P0-3. Fix NaN/Infinity accepted as closed PnL

**File:** `tools/dlmm.js` lines ~1146–1153, function `shouldRejectClosedPnl`

**Problem:**

```js
if (!Number.isFinite(pct)) return false; // BUG: accepts non-finite
```

When `pct` is NaN or Infinity, returns `false` (don't reject), so garbage values pass through and poison the learning data.

**Current:**

```js
if (!Number.isFinite(pct)) return false;
```

**Fix:**

```js
if (!Number.isFinite(pct)) return true; // Reject NaN/Infinity
```

**Verification:** Search the DB/lesson records for any NaN or Infinity PnL values and manually clean them.

---

### P0-4. Fix hardcoded 10% slippage — make configurable

**Files:** `tools/dlmm.js`, `config.js`

**Problem:** Deploy and recompound use hardcoded `slippage: 10` (10%). Jupiter swaps pass no slippage parameter at all. No MEV protection (no priority fees, no Jito tips).

**Step 1: Add slippage config in `config.js`**

In the `strategy` section (~line 45), add:

```js
strategy: {
    // ... existing fields ...
    deploySlippageBps: u.deploySlippageBps ?? 300,    // 3% default (was hardcoded 1000)
    recompoundSlippageBps: u.recompoundSlippageBps ?? 300, // 3%
},
```

**Step 2: Use config in `dlmm.js` deploy (~lines 312, 328)**

Replace all `slippage: 10` and `slippage: 1000` with:

```js
slippage: config.strategy.deploySlippageBps / 100,   // for chunkable path (expects %)
// and
slippage: config.strategy.deploySlippageBps,          // for standard path (expects bps)
```

**Step 3: Use config in `dlmm.js` recompound (~lines 960, 974)**

Same pattern but with `recompoundSlippageBps`.

**Step 4: Add slippage to Jupiter swap in `tools/wallet.js` (~line 176-181)**

**Current:**

```js
const orderUrl =
    `${JUPITER_SWAP_V2_API}/order` +
    `?inputMint=${input_mint}` +
    `&outputMint=${output_mint}` +
    `&amount=${amountStr}` +
    `&taker=${wallet.publicKey.toString()}`;
```

**Fix:**

```js
const swapSlippageBps = config.strategy?.deploySlippageBps ?? 300;
const orderUrl =
    `${JUPITER_SWAP_V2_API}/order` +
    `?inputMint=${input_mint}` +
    `&outputMint=${output_mint}` +
    `&amount=${amountStr}` +
    `&taker=${wallet.publicKey.toString()}` +
    `&slippageBps=${swapSlippageBps}`;
```

---

### P0-5. Fix wide-range deploy retry creating orphan positions

**File:** `tools/dlmm.js` lines ~270–346

**Problem:** Keypair is generated once outside the retry loop. If Phase 2 (add liquidity) fails on attempt 0, retry re-tries Phase 1 (create position) with the same keypair — fails because account already exists. Leaves orphan position consuming rent.

**Current structure:**

```js
const newPosition = Keypair.generate(); // outside loop
for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES; attempt++) {
    // Phase 1: createExtendedEmptyPosition(newPosition)
    // Phase 2: addLiquidityByStrategy(...) — may fail
    // Retry: Phase 1 fails (account exists)
}
```

**Fix:**

```js
for (let attempt = 0; attempt <= MAX_DEPLOY_RETRIES; attempt++) {
    const newPosition = Keypair.generate(); // Generate FRESH keypair each attempt
    try {
        // Phase 1: createExtendedEmptyPosition(newPosition)
        // Phase 2: addLiquidityByStrategy(...)
        break; // success
    } catch (err) {
        if (attempt === MAX_DEPLOY_RETRIES) throw err;
        log("dlmm_warn", `Deploy attempt ${attempt} failed, retrying with new keypair...`, err.message);
        // Optionally: close the orphan account from the failed attempt
    }
}
```

**Verification:** After a failed deploy, check that no empty position accounts remain on-chain for the wallet.

---

### P0-6. Don't discard rug-pull losses — learn from them

**File:** `lessons.js` lines ~138–147

**Problem:** Positions that lose >90% without stop-loss trigger are silently skipped. These are the most important failures to learn from.

**Current:**

```js
const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record ...`);
    return; // SKIPPED — no lesson
}
```

**Fix — generate a lesson instead of skipping:**

```js
if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Severe loss detected (likely rug/honeypot), generating caution lesson...`);
    // Override pnl_pct to -90 for the lesson (cap the extreme value)
    // but still generate a "bad" outcome lesson with the real data
    perf = { ...perf, pnl_pct: -90 };
    // Fall through to normal lesson generation — do NOT return here
}
```

---

## P1 — High Impact

### P1-1. Fix single-factor scoring in screening

**File:** `tools/screening.js` lines ~22–28, function `scoreCandidate`

**Problem:** `feeTvl * 1000` dominates all other factors.

**Current:**

```js
function scoreCandidate(pool) {
    const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
    const organic = Number(pool.organic_score || 0);
    const volume = Number(pool.volume_window || 0);
    const holders = Number(pool.holders || 0);
    return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}
```

**Fix — normalize and weight:**

```js
function scoreCandidate(pool) {
    const feeTvl = Math.min(Number(pool.fee_active_tvl_ratio || 0), 10); // cap at 10
    const organic = Number(pool.organic_score || 0);
    const volume = Number(pool.volume_window || 0);
    const holders = Number(pool.holders || 0);
    const liquidity = Number(pool.active_tvl || 0);

    // Normalize each to 0–10 scale then apply weights
    const feeTvlScore = feeTvl * 2; // max 20
    const organicScore = Math.min(organic / 10, 10) * 3; // max 30
    const volumeScore = Math.min(volume / 5000, 10) * 2; // max 20
    const holdersScore = Math.min(holders / 500, 10) * 2; // max 20
    const liquidityScore = Math.min(liquidity / 50000, 10) * 1; // max 10

    return feeTvlScore + organicScore + volumeScore + holdersScore + liquidityScore;
}
```

Adjust the divisor constants (`/10`, `/5000`, `/500`, `/50000`) based on your observed data ranges. The key change is capping fee/TVL and giving organic score more weight.

---

### P1-2. Fix volatility weight direction (Math.abs bug)

**File:** `signal-weights.js` ~line 225

**Problem:** For signals NOT in `HIGHER_IS_BETTER` (volatility, mcap), `Math.abs()` makes the lift always positive regardless of direction.

**Current:**

```js
return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
```

**Fix:**

```js
// For signals where LOWER is better (volatility, mcap):
// positive lift means winners had LOWER values → correct
// negative lift means losers had LOWER values → suppress weight
return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : lossMean - winMean;
```

Wait — check which signals are in `HIGHER_IS_BETTER` and which direction is desired. For volatility: lower is better (winners have lower vol). So if `winMean < lossMean` (winners have lower vol), `lossMean - winMean` is positive = boost. If `winMean > lossMean` (winners had higher vol), `lossMean - winMean` is negative = decay. This is the correct direction.

---

### P1-3. Fix position-level vs pool-level fee rate comparison

**File:** `state.js` lines ~533–546 (setEntryFeeRate) and ~852–888 (computeFeeRateDecay)

**Problem:** Entry fee rate is position-specific (higher for concentrated positions), but current rate in decay check uses pool-level raw fees/60. This creates phantom decay.

**Fix in `computeFeeRateDecay` — also compute position-specific current rate:**

```js
// Instead of:
const currentFeeRate = poolFees1h / 60;

// Use position-adjusted rate (matching how entry was calculated):
const currentFeeRate = (poolFees1h / 60) * positionConcentrationFactor;
```

Where `positionConcentrationFactor` is derived from the position's bin range vs total active bins. Store this factor alongside `entry_fee_rate` in `setEntryFeeRate` so it can be reused.

Alternatively (simpler): store the pool-level fee rate at entry alongside the position-specific rate, and compare pool-level to pool-level for decay detection.

**Add to position tracking:**

```js
// In setEntryFeeRate:
pos.entry_pool_fee_rate = poolFeesPerMinute; // raw pool-level rate
pos.position_concentration = posSpecificRate / poolFeesPerMinute; // concentration multiplier
```

**In decay check:**

```js
const currentPoolFeeRate = poolFees1h / 60;
const decayPct =
    pos.peak_pool_fee_rate > 0 ? ((pos.peak_pool_fee_rate - currentPoolFeeRate) / pos.peak_pool_fee_rate) * 100 : 0;
```

---

### P1-4. Lower default stop-loss, enable IL stop

**File:** `config.js`

**Current (~line 67):**

```js
stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
```

**Fix:**

```js
stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -25,
```

**Current (~line 81):**

```js
dynamicILStop: u.dynamicILStop ?? false,
```

**Fix:**

```js
dynamicILStop: u.dynamicILStop ?? true,
```

---

### P1-5. Align prompt with config values

**File:** `prompt.js`

**Problem:** Prompt hard-codes values that contradict `config.js`. The prompt says stop-loss at -25% and trailing trigger at +4%, but config says -50% and +3%.

**Fix — read from config instead of hard-coding:**

In the MANAGER prompt section (~lines 33-60), replace hardcoded values with config references:

```js
// Instead of:
// "Hard stop-loss: close if PnL drops below -25%"

// Use:
`Hard stop-loss: close if PnL drops below ${config.management.stopLossPct}%`
// Instead of:
// "Trailing stop: trigger at +4% PnL, close if drops to +2%"

// Use:
`Trailing take-profit: trigger at +${config.management.trailingTriggerPct}% PnL, close if PnL drops ${config.management.trailingDropPct}% from peak`;
```

Do this for ALL hardcoded management values in the prompt (stop-loss, take-profit, trailing trigger, trailing drop, etc.)

---

### P1-6. Add portfolio-level circuit breaker

**File:** `config.js` — add new config, `index.js` — add enforcement

**In config.js `risk` section:**

```js
risk: {
    maxPositions: u.maxPositions ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    maxDailyLossSol: u.maxDailyLossSol ?? 2.0,    // Stop deploying if daily loss > 2 SOL
    maxConsecutiveLosses: u.maxConsecutiveLosses ?? 4, // Pause after 4 consecutive losses
},
```

**In `index.js` — before `runScreeningCycle()` starts a deploy, add check:**

```js
function checkCircuitBreaker() {
    // Check daily loss
    const last24h = getClosedPositionsLast24h(); // need to implement or reuse briefing logic
    const dailyLossSol = last24h.filter((p) => (p.pnl_usd ?? 0) < 0).reduce((sum, p) => sum + Math.abs(p.pnl_usd), 0);
    if (dailyLossSol > config.risk.maxDailyLossSol) {
        log(
            "risk",
            `Circuit breaker: daily loss ${dailyLossSol.toFixed(2)} SOL exceeds limit ${config.risk.maxDailyLossSol}`,
        );
        return true; // TRIPPED
    }

    // Check consecutive losses
    const recentCloses = last24h.slice(-config.risk.maxConsecutiveLosses);
    if (recentCloses.length >= config.risk.maxConsecutiveLosses && recentCloses.every((p) => (p.pnl_usd ?? 0) < 0)) {
        log("risk", `Circuit breaker: ${config.risk.maxConsecutiveLosses} consecutive losses`);
        return true; // TRIPPED
    }

    return false; // OK to trade
}
```

Gate the deploy path:

```js
// In runScreeningCycle, before calling deploy_position:
if (checkCircuitBreaker()) {
    log("screening", "Skipping deploy — circuit breaker tripped");
    return null;
}
```

---

### P1-7. Fix lesson scorer strategy match giving free +0.5

**File:** `lesson-scorer.js` lines ~119–123

**Current:**

```js
if (signals.strategy) {
    factors++;
    score += 0.5; // Always 0.5, never checks pool's strategy
}
```

**Fix:**

```js
if (signals.strategy) {
    factors++;
    // Only score if the pool's strategy matches the lesson's strategy
    if (pool.strategy === signals.strategy) {
        score += 1;
    } else {
        score += 0.2; // Small soft signal, not 0.5
    }
}
```

---

### P1-8. Fix confirmed exits expiring silently after 30s

**File:** `state.js` lines ~720–755

**Problem:** Confirmed exits expire after 30s with no re-trigger mechanism.

**Fix — instead of silently clearing, re-queue a confirmation:**

```js
// When confirmed exit window expires:
if (new Date(pos.confirmed_stop_loss_exit_until).getTime() <= Date.now()) {
    // DON'T silently clear — re-queue for confirmation
    log("state_warn", `Confirmed exit window expired, re-queuing confirmation for ${pos.pool_name}`);

    // Extend the window once (give another 60s)
    if (!pos.exit_retried) {
        pos.exit_retried = true;
        pos.confirmed_stop_loss_exit_until = new Date(Date.now() + 60_000).toISOString();
        // Keep the reason, don't clear it
        return null; // Let next cycle pick it up
    }

    // Already retried once, now clear
    pos.confirmed_stop_loss_exit_reason = null;
    pos.confirmed_stop_loss_exit_until = null;
    pos.exit_retried = false;
}
```

---

### P1-9. Fix close result missing SOL fields for tracked positions

**File:** `tools/dlmm.js` lines ~1262–1273

**Current (tracked path — missing fields):**

```js
return {
  success: true, position, pool, pool_name, claim_txs, close_txs, txs,
  pnl_usd: pnlUsd, pnl_pct: pnlPct, base_mint: ...
};
```

**Fix — add the same fields as the untracked path:**

```js
return {
  success: true, position, pool, pool_name, claim_txs, close_txs, txs,
  pnl_usd: pnlUsd, pnl_pct: pnlPct, base_mint: ...,
  initial_sol: initialSol,
  withdrawn_sol: withdrawnSol,
  fees_sol: feesSol,
};
```

Ensure `initialSol`, `withdrawnSol`, `feesSol` are computed before the return statement (they should already be computed in the tracked path, just not returned).

---

## P2 — Medium Impact

### P2-1. Fix take-profit firing before trailing TP

**File:** `state.js` function `updatePnlAndCheckExits` (~lines 790–823)

**Current order:** Take-profit check → trailing TP check

**Fix — if trailing is already active, skip fixed take-profit:**

```js
// Take-profit check (line 790):
if (!pnl_pct_suspicious && currentPnlPct != null
    && currentPnlPct >= mgmtConfig.takeProfitPct
    && !pos.trailing_active) {  // ADD: skip if trailing is active
    return { action: "TAKE_PROFIT", ... };
}
```

---

### P2-2. Add floating-point precision fix for token amounts

**File:** `tools/dlmm.js` lines ~258, 265, 940

**Current:**

```js
new BN(Math.floor(finalAmountY * 1e9));
new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
```

**Fix — use Math.round or string-based BN:**

```js
new BN(Math.round(finalAmountY * 1e9).toString());
new BN(Math.round(finalAmountX * Math.pow(10, decimals)).toString());
```

Apply this pattern everywhere `Math.floor` is used with BN construction for token amounts.

---

### P2-3. Fix fee/TVL fallback using raw windowed values

**File:** `tools/screening.js` lines ~505–507

**Current:**

```js
fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
  ? fix(p.fee_active_tvl_ratio, 4)
  : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
```

**Problem:** When API returns 0, fallback computes raw windowed ratio, not annualized. Short-timeframe pools get inflated values.

**Fix — annualize the fallback:**

```js
fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
  ? fix(p.fee_active_tvl_ratio, 4)
  : (p.active_tvl > 0
      ? fix(((p.fee / p.active_tvl) * 100) * (365 * 24 * 12 / timeframeMinutes), 4)
      : 0),
```

Where `timeframeMinutes` is the window duration (e.g., 5 for 5-minute windows). This annualizes the raw ratio to be comparable with the API's annualized value.

---

### P2-4. Make 0–5% PnL trades generate lessons

**File:** `lessons.js` lines ~279–290

**Current:**

```js
if (outcome === "neutral") return null; // No lesson for 0–5% PnL
```

**Fix — generate a lightweight lesson:**

```js
if (outcome === "neutral") {
    // Still generate a lesson but with lower confidence
    confidence = 0.3;
    // Fall through to lesson generation instead of returning null
}
```

---

### P2-5. Fix lesson scorer inconsistent scales

**File:** `lesson-scorer.js`

**Problem:** `scorePoolByLessons()` adjusts by ±25 per lesson (scale 0–100), while `scorePool()` adjusts by ±0.25 per lesson (scale -0.5 to 0.5). 100x difference.

**Fix — standardize to use the same scale.** Make both functions call a shared core:

```js
function computeLessonDelta(pool, lessons, direction) {
    // Shared logic — returns raw delta
    let delta = 0;
    // ... matching logic ...
    return delta;
}

function scorePoolByLessons(pool, lessons) {
    const baseScore = 50;
    const delta = computeLessonDelta(pool, lessons);
    return Math.max(0, Math.min(100, baseScore + delta * 25));
}

function scorePool(pool, lessons) {
    const delta = computeLessonDelta(pool, lessons);
    return Math.max(-0.5, Math.min(0.5, delta * 0.25));
}
```

---

### P2-6. Add PnL sanity check bypass for extreme losses

**File:** `state.js` lines ~779–787

**Problem:** When `pnl_pct_suspicious` is true (reported vs derived PnL diverge >5%), ALL exit checks are skipped — including stop-loss. During a crash, data sources legitimately diverge.

**Fix — allow stop-loss through even when suspicious, but with stricter threshold:**

```js
// Stop-loss check:
const stopLossThreshold = pnl_pct_suspicious
    ? mgmtConfig.stopLossPct * 1.5  // 50% stricter when data is uncertain
    : mgmtConfig.stopLossPct;

if (currentPnlPct != null && currentPnlPct <= stopLossThreshold) {
    return { action: "STOP_LOSS", ... };
}
```

---

### P2-7. Add recompound price check

**File:** `index.js` lines ~556–567

**Problem:** Recompound adds X token (fees) back to position without checking if token price has crashed.

**Fix — add a guard before recompound:**

```js
// Before recompound:
const currentPriceVsEntry = getCurrentTokenPrice(baseMint) / pos.entry_token_price;
if (currentPriceVsEntry < 0.5) {
    // Token lost >50% value — skip recompound, consider closing instead
    log("recompound", `Skipping recompound for ${poolName}: token price dropped ${(1 - currentPriceVsEntry) * 100}% from entry`);
    continue;
}
```

---

### P2-8. Fix pool cache cleared on fixed timer

**File:** `tools/dlmm.js` line ~93

**Current:**

```js
setInterval(() => poolCache.clear(), 15 * 60 * 1000);
```

**Fix — evict entries older than 5 minutes individually, refresh before critical operations:**

```js
const POOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getPool(poolAddress) {
    const key = poolAddress.toString();
    const cached = poolCache.get(key);
    if (cached && Date.now() - cached.ts < POOL_CACHE_TTL) {
        return cached.pool;
    }
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, { pool, ts: Date.now() });
    return pool;
}
```

Also add explicit cache bust before deploy:

```js
// Before deployPosition:
poolCache.delete(poolAddress.toString());
```

---

### P2-9. Unhide auto-swap failure notification

**File:** `tools/executor.js` lines ~591–592

**Current:**

```js
// notifySwapFailed is COMMENTED OUT
```

**Fix — uncomment and enable:**

```js
if (rpcBalance > 0) {
    // ... swap ...
} else {
    log("executor_warn", `Auto-swap skipped: no base token balance found`);
    notifySwapFailed(position, baseMint); // UNCOMMENT THIS
}
```

---

### P2-10. Fix lesson evolution threshold too aggressive with small samples

**File:** `lessons.js` lines ~373–420

**Current:**

```js
const MIN_EVOLVE_POSITIONS = 5;
```

**Fix:**

```js
const MIN_EVOLVE_POSITIONS = 15; // Need more data before changing thresholds
```

Also add a guard to prevent >30% threshold change in a single evolution step:

```js
const maxChange = current * 0.3; // Max 30% change per evolution
const target = Math.max(current - maxChange, loserP25 * 1.15);
```

---

## General Improvements (No Bug — Enhancement)

### GEN-1. Add transaction fee accounting to PnL

In `state.js` or `dlmm.js`, track:

- Total SOL spent on transaction fees per position (deploy + close + recompound txs)
- Jupiter platform fee from swap responses
- Deduct these from the final PnL calculation

This gives a true net PnL instead of the current gross figure.

### GEN-2. Add per-token concentration enforcement

In the deploy path (`executor.js`), before calling `deployPosition`, check:

```js
const existingExposure = positions.filter((p) => p.base_mint === candidateBaseMint);
const totalExposurePct = existingExposure.reduce((sum, p) => sum + p.amount_sol, 0) / totalPortfolioValue;
if (totalExposurePct > 0.3) {
    // 30% max per token
    reject("Token concentration limit reached");
}
```

Make this a hard block, not advisory.

### GEN-3. Add wash trading heuristic fallback

In `screening.js`, when OKX API fails, apply a local heuristic:

- Flag pools where volume/holders ratio is >10x median
- Flag pools where top 3 wallets hold >50% of supply
- Flag pools with >80% volume in a single transaction

### GEN-4. Widen volatility match tolerance in lesson scorer

**File:** `lesson-scorer.js` lines ~86–93

Change tolerance from ±1.0 / ±2.0 to ±2.0 / ±4.0 to allow cross-volatility-range lesson transfer.

---

## Verification Checklist

After applying all fixes, verify:

1. `node test/test-exit-strategies.js` — all exit strategy tests pass
2. `node test/test-state-history.js` — state tracking tests pass
3. `node test/test-agent.js` — agent tool tests pass
4. `node test/test-screening.js` — screening tests pass
5. `node test/test-volume-decay.js` — volume decay tests pass
6. `node test/test-fee-rate-decay.js` — fee rate decay tests pass
7. `node test/backtest-sim.js` — backtest simulation passes
8. Manual: deploy a small test position and verify:
    - PnL reported matches Meteora UI
    - Stop-loss triggers correctly at configured threshold
    - Close notification shows correct SOL amounts
    - No orphan positions after failed deploy
