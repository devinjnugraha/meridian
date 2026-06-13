# Deployment Strategy

## Bin Range Calculation

### bins_below Calculation

Formula: `35 + (volatility / 5) * (binsBelow - 35)`, clamped to [35, binsBelow]

Examples (default binsBelow=69):
- Volatility 0 → 35 bins
- Volatility 2 → 49 bins  
- Volatility 5+ → 69 bins

### Deployment Amount Calculation

Formula: `clamp((wallet - gasReserve) * positionSizePct, min=deployAmountSol, max=maxDeployAmount)`

Examples (defaults: gasReserve=0.2, positionSizePct=0.35, min=0.5):
- 0.8 SOL wallet → 0.6 SOL deploy (min applied)
- 2.0 SOL wallet → 0.63 SOL deploy
- 3.0 SOL wallet → 0.98 SOL deploy
- 4.0 SOL wallet → 1.33 SOL deploy

## Strategy Types

### spot
- Single-sided SOL
- Liquidity placed symmetrically around active bin
- Default for low-volatility pools

### curve
- Single-sided SOL
- More liquidity concentrated near active bin
- Better for moderate volatility

### bid_ask
- Single-sided SOL
- Liquidity skewed toward bid (SOL side)
- Best for high-volatility pools

## Position Sizing

**Single-sided only**: All liquidity is SOL (quote token)
- `bins_above` is always 0
- `bins_below` determines range width
- No base token held

**Range coverage**:
- Lower bound: `active_bin - bins_below`
- Upper bound: `active_bin + bins_above` (always 0)
- Coverage downside: `% below current price`
- Coverage upside: `% above current price` (always 0)

## Deploy Safety Checks

1. Pool not on cooldown
2. Base mint not on cooldown
3. No duplicate pool positions
4. No duplicate base token positions
5. Amount >= minimum deploy
6. Amount <= maximum deploy
7. SOL balance >= amount + gas reserve

## Exit Triggers

### Trailing Take Profit
1. PnL >= trailingTriggerPct (default 3%)
2. Trailing TP activated
3. Monitor for trailingDropPct (default 1.5%) drop from peak
4. 15-second confirmation timer
5. Recheck after timer to confirm drop
6. Close if confirmed

### Stop Loss
1. PnL <= stopLossPct (default -50%)
2. 15-second confirmation timer
3. Recheck after timer to confirm still below threshold
4. Close if confirmed

### Out of Range
1. Position out of range
2. Monitor OOR duration
3. Close if OOR > outOfRangeWaitMinutes (default 30)
4. Special handling for "pumped far above range"

### Low Yield
1. Position age > minAgeBeforeYieldCheck (default 60 min)
2. Fee/TVL < minFeePerTvl24h (default 7%)
3. Close to redeploy elsewhere

### Fee Rate Decay
1. Entry fee rate recorded at deploy
2. Peak fee rate tracked
3. If decayPct > feeRateDropPct (default 60%)
4. And fees earned >= minFeesBeforeFeeRateExit (default 0.5)
5. Close to prevent further decay

### Volume Decay
1. Entry volume recorded at deploy
2. Current volume fetched each cycle
3. If decayPct > volumeDecayPct (default 70%)
4. And fees earned >= minFeesBeforeExit (default 0.5)
5. Close to prevent further losses

### Impermanent Loss Stop
1. Dynamic IL stop enabled in config
2. Calculate IL vs fees projected daily
3. If recovery time > ilRecoveryMaxDays (default 3)
4. And IL >= ilStopMinPct (default -3%)
5. And position age >= ilStopMinAgeMinutes (default 30)
6. Close to prevent further IL

## Cooldown System

### Pool Cooldowns
- **Low yield**: 4 hours
- **Repeated OOR (3x)**: 12 hours
- **2 consecutive losses**: 8 hours

### Token Cooldowns
- Same triggers as pool cooldowns
- Applies to all positions with that base mint

### Cooldown Check
- `isPoolOnCooldown(pool_address)` - Check pool cooldown
- `isBaseMintOnCooldown(base_mint)` - Check token cooldown

## Auto-Swap After Close

**Behavior**:
1. After close_position, check wallet for base tokens
2. If token USD value >= $0.10:
   - Swap to SOL via Jupiter Swap V2
   - Mark as auto_swapped so model doesn't call again
3. If token USD value < $0.10 (dust):
   - Skip swap (not worth gas)
   - Leave in wallet

**Configuration**:
- `autoSwapAfterClaim` - Also swap after claim (default false)
- `dustThresholdUsd` - Minimum token value to swap (default 0.10)

## Dynamic Schedule

After deploy, management interval is set based on pool volatility:
- Volatility >= 5 → 3 minutes
- Volatility 2-5 → 5 minutes
- Volatility < 2 → 10 minutes

Changes are:
1. Applied to live config
2. Saved to user-config.json
3. Cron jobs restarted
4. Logged for transparency