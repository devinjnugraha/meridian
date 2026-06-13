# Exit Rules Documentation

## Overview

Meridian uses a combination of deterministic rules and LLM evaluation to decide when to close positions. Rules are checked in priority order.

## Priority Order

1. **Confirmed Exit Conditions** (highest priority)
   - Pending stop loss confirmation
   - Pending trailing TP confirmation
   - Pending IL stop confirmation

2. **Instruction-Based** (user-set conditions)
   - Position has set instruction
   - Instruction condition is met

3. **Deterministic Rules** (no LLM needed)
   - Out of range wait timeout
   - Trailing TP triggered
   - Stop loss triggered
   - Low yield detected
   - Volume decay detected
   - IL stop triggered

4. **LLM Evaluation** (for instruction non-matches)
   - Evaluate whether to HOLD, CLOSE, or INSTRUCTION
   - Uses all available data

## Deterministic Exit Rules

### 1. Out of Range (OOR)

**Trigger**: Position is out of range for OOR wait minutes

**Logic**:
```
if (minutes_out_of_range > outOfRangeWaitMinutes):
    close_position
```

**Special Case**: "Pumped far above range"
- Price moved far above upper bound
- Position is permanently out of range
- Immediate close

**Configuration**:
- `outOfRangeWaitMinutes` (default 30)
- `outOfRangeBinsToClose` (default 10)
- `outOfRangeBinsToCloseBelow` (default 10)

### 2. Trailing Take Profit

**Trigger**: PnL drops X% from peak after being above trigger

**Logic**:
```
if (peak_pnl_pct >= trailingTriggerPct):
    if (current_pnl_pct <= peak_pnl_pct - trailingDropPct):
        close_position
```

**Example**:
- Peak PnL: 5%
- Current PnL: 3.4%
- Trailing drop: 1.5%
- Action: Close (5 - 3.4 = 1.6% drop >= 1.5%)

**Configuration**:
- `trailingTakeProfit` (default true)
- `trailingTriggerPct` (default 3)
- `trailingDropPct` (default 1.5)

**Confirmation Mechanism**:
1. PnL above trigger → queue peak confirmation
2. After 15 seconds → recheck PnL
3. If still near peak → confirm
4. When drop detected → queue drop confirmation
5. After 15 seconds → recheck
6. If drop confirmed → close

### 3. Stop Loss

**Trigger**: PnL drops below hard threshold

**Logic**:
```
if (pnl_pct <= stopLossPct):
    close_position
```

**Configuration**:
- `stopLossPct` (default -50%)

**Confirmation Mechanism**:
1. PnL below threshold → queue confirmation
2. After 15 seconds → recheck
3. If still below → close

### 4. Low Yield

**Trigger**: Fee/TVL ratio drops below minimum

**Logic**:
```
if (position_age > minAgeBeforeYieldCheck):
    if (fee_per_tvl_24h < minFeePerTvl24h):
        close_position
```

**Configuration**:
- `minFeePerTvl24h` (default 7%)
- `minAgeBeforeYieldCheck` (default 60 minutes)

**Purpose**: Redeploy to higher-yielding pools

### 5. Fee Rate Decay

**Trigger**: Current fee rate drops significantly from peak

**Logic**:
```
entry_fee_rate = fee at deploy
peak_fee_rate = highest fee rate observed
current_fee_rate = current pool fees / 60

if (peak_fee_rate > 0):
    decay_pct = (peak_fee_rate - current_fee_rate) / peak_fee_rate * 100
    if (decay_pct > feeRateDropPct):
        if (fees_earned >= minFeesBeforeFeeRateExit):
            close_position
```

**Configuration**:
- `feeRateDecayEnabled` (default true)
- `feeRateDropPct` (default 60%)
- `minFeesBeforeFeeRateExit` (default 0.5)

**Purpose**: Exit when pool's fee-earning capacity has permanently declined

### 6. Volume Decay

**Trigger**: Pool volume drops significantly from entry level

**Logic**:
```
entry_volume = volume at deploy
current_volume = current volume (same timeframe)

decay_pct = (entry_volume - current_volume) / entry_volume * 100
if (decay_pct > volumeDecayPct):
    if (fees_earned >= minFeesBeforeExit):
        close_position
```

**Configuration**:
- `volumeDecayEnabled` (default true)
- `volumeDecayPct` (default 70%)
- `minFeesBeforeExit` (default 0.5)

**Purpose**: Exit when pool liquidity has evaporated

### 7. Impermanent Loss Stop

**Trigger**: IL recovery time exceeds threshold

**Logic**:
```
il_pct = (impermanent_loss / initial_value) * 100
projected_daily_fee = projected daily fee earnings
days_to_recover = |il_pct| / (projected_daily_fee * 100)

if (days_to_recover > ilRecoveryMaxDays):
    if (il_pct <= ilStopMinPct):
        if (position_age >= ilStopMinAgeMinutes):
            close_position
```

**Configuration**:
- `dynamicILStop` (default false - must be enabled)
- `ilRecoveryMaxDays` (default 3)
- `ilStopMinPct` (default -3%)
- `ilStopMinAgeMinutes` (default 30)

**Purpose**: Exit early when IL cannot be recovered

## Instruction-Based Exits

### Set Instruction

Users can set instructions on positions:
```javascript
 setPositionInstruction(position_address, "close at 5% profit")
```

**Supported Instructions**:
- "close at X% profit" - Close when PnL >= X%
- "hold until X% profit" - Hold until PnL >= X%
- "close if OOR > X minutes" - Close if out of range

**Check Logic**:
1. If position has instruction → check condition FIRST
2. If condition met → close immediately
3. If condition not met → continue with normal checks

**Purpose**: Give users precise control over specific positions

## Deterministic vs LLM

### Deterministic (No LLM)

These rules are applied before LLM evaluation:
- Confirmed exits (trailing TP, stop loss, IL stop)
- OOR wait timeout
- Trailing TP triggered
- Stop loss triggered
- Low yield detected
- Volume decay detected
- IL stop triggered

**Benefits**:
- Fast decision making
- No LLM cost
- No hallucination risk
- Consistent behavior

### LLM Evaluation

Used for:
- Evaluating instructions that aren't met
- Holding decisions
- Complex scenarios

**LLM Prompt Includes**:
- Current position data
- All exit conditions
- Pool history
- Recent performance
- Lessons learned

**Output**: HOLD, CLOSE, or INSTRUCTION

## Action Summary

| Condition | Action | LLM Needed | Notes |
|-----------|--------|------------|-------|
| Confirmed stop loss | CLOSE | No | Highest priority |
| Confirmed trailing TP | CLOSE | No | 15-second recheck |
| Confirmed IL stop | CLOSE | No | Dynamic IL stop enabled |
| Instruction met | CLOSE | No | Instruction check first |
| OOR > wait minutes | CLOSE | No | Based on volatility |
| Trailing drop detected | CLOSE | No | After 15s recheck |
| PnL < stop loss | CLOSE | No | After 15s recheck |
| Fee/TVL < threshold | CLOSE | No | Low yield |
| Volume decay > % | CLOSE | No | Pool liquidity gone |
| IL recovery > days | CLOSE | No | Dynamic IL stop enabled |
| Instruction not met | HOLD/CLOSE | Yes | LLM decides |
| No condition met | HOLD | Yes | LLM decides |