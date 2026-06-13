# Agent Details

## Hunter Alpha (SCREENER)

### Role
Pool screening and deployment - the "hunter" that finds and secures new opportunities.

### Schedule
Runs every `screeningIntervalMin` minutes (default: 30 minutes)

### Toolset

**Read-Only Tools**:
- `get_my_positions` - Check current positions
- `get_top_candidates` - Get screening candidates
- `get_pool_detail` - Get pool metadata
- `get_active_bin` - Get pool's active bin
- `get_token_info` - Get token information
- `get_token_holders` - Get token holders
- `get_token_narrative` - Get token narrative
- `check_smart_wallets_on_pool` - Check smart wallet presence
- `get_pool_memory` - Get pool deploy history
- `get_cooldown_tokens` - Get tokens on cooldown
- `get_pool_history` - Get pool historical metrics
- `get_performance_history` - Get position performance
- `get_recent_decisions` - Get agent decisions
- `list_lessons` - List agent lessons
- `list_blacklist` - List blacklisted tokens
- `get_wallet_balance` - Get wallet balances

**Write Tools**:
- `deploy_position` - Open new position
- `skip_deploy` - Skip deployment for candidate
- `add_pool_note` - Add note to pool
- `add_to_blacklist` - Add token to blacklist
- `update_config` - Update configuration

### Decision Process

**Step 1: Fetch Candidates**
```javascript
const candidates = await getTopCandidates({ limit: 10 })
```
- Filters pools by screening thresholds
- Enriches with pool history, OKX data, DexScreener data
- Excludes blacklisted tokens and blocked devs
- Excludes PVP rivals (if enabled)

**Step 2: Study Top LPers**
```javascript
for (const pool of candidatePools) {
  await studyTopLPers({ pool_address: pool.pool })
}
```
- Analyzes top 5 LPers in each pool
- Looks for patterns: entry/exit timing, scalping vs holding
- Saves lessons to lessons.json
- Provides insights to LLM

**Step 3: Pool History Enrichment**
```javascript
enrichCandidatesWithHistory(candidates)
```
- Adds prior deployment outcomes for each pool
- Adds signal snapshots from last deploy
- Adds cooldown status
- Adds recent trend data from snapshots

**Step 4: LLM Evaluation**
```javascript
const result = await agentLoop(goal, maxSteps, [], "SCREENER")
```

**System Prompt Highlights**:
- HUNTER role (find best opportunities)
- Emphasizes patience and gas efficiency
- Hard rules: skip pools with fees_sol < minTokenFeesSol
- PVP risk warnings
- Narrative quality assessment
- Smart wallet presence as bullish signal

**Prompt Includes**:
- Current portfolio state
- Config thresholds
- Screened candidates (top 10)
- Lessons learned
- Performance summary
- Signal weights
- Pool history per candidate

**Candidate Output Format**:
```json
{
  "pool": "pool_address...",
  "name": "TOKEN-SOL",
  "base": {
    "symbol": "TOKEN",
    "mint": "mint...",
    "organic": 85
  },
  "quote": { "symbol": "SOL" },
  "bin_step": 100,
  "fee_active_tvl_ratio": 0.12,
  "volume_window": 5000,
  "holders": 1200,
  "mcap": 2000000,
  "volatility": 3.5,
  "discord_signal": true,
  "discord_signal_count": 3,
  "risk_level": "low",
  "pvp_risk": "none",
  "ds_price_change": { "5m": 5.2, "15m": 8.1 },
  "ds_txns": { "buys": 120, "sells": 80 },
  "ds_volume": { "5m": 5000 },
  "strategy": "bid_ask",
  "bins_below": 69,
  "history": {
    "found": true,
    "total_deploys": 3,
    "avg_pnl_pct": 2.5,
    "win_rate": 66.67,
    "last_outcome": "profit",
    "signal_snapshot": { "organic_score": 85, "fee_tvl_ratio": 0.12 }
  }
}
```

**Output Expectation**:
1. Analyze each candidate's history
2. Compare signal snapshots
3. Identify dump patterns vs genuine momentum
4. Check cooldown status
5. Select best candidate or skip
6. Call `deploy_position` or `skip_deploy`

### Key Behaviors

**Hard Rules**:
1. Skip pools with fees_sol < minTokenFeesSol (default 30 SOL)
2. Skip blacklisted tokens
3. Skip blocked devs
4. Skip PVP rivals if blockPvpSymbols=true
5. Skip pools on cooldown
6. Skip tokens on cooldown
7. Skip if wallet has open position in pool
8. Skip if wallet holding base token in another pool

**Risk Signals**:
- High bundle % (>30%) → suspicious
- High bot holder % (>30%) → bot activity
- High top 10 concentration (>60%) → risky
- Low organic score (<60%) → low quality
- Low holder count (<500) → low community
- Wash trading flag → hard skip
- Honeypot flag → hard skip

**Smart Wallets**:
- Presence is bullish signal
- Overrides weak narrative
- Only valid rugpull override (with high conviction)

**Narrative Quality**:
- GOOD: Specific origin, real event, named entity, active community
- BAD: Generic hype, no identifiable subject
- Smart wallets can override weak narrative

**Dump Pattern Detection**:
- Volume up >80% + mcap down >15% = selling pressure
- Volume up + mcap stable/up = genuine momentum
- Volume up but mcap flat = ambiguous

### Configuration

```json
{
  "screening": {
    "minFeeActiveTvlRatio": 0.05,
    "minTvl": 10000,
    "maxTvl": 150000,
    "minVolume": 500,
    "minOrganic": 60,
    "minQuoteOrganic": 60,
    "minHolders": 500,
    "minMcap": 150000,
    "maxMcap": 10000000,
    "minBinStep": 80,
    "maxBinStep": 125,
    "timeframe": "5m",
    "category": "trending",
    "minTokenFeesSol": 30,
    "excludeHighSupplyConcentration": true,
    "useDiscordSignals": false,
    "discordSignalMode": "merge",
    "avoidPvpSymbols": true,
    "blockPvpSymbols": false,
    "maxBundlePct": 30,
    "maxBotHoldersPct": 30,
    "maxTop10Pct": 60,
    "minTokenAgeHours": null,
    "maxTokenAgeHours": null,
    "athFilterPct": null
  }
}
```

---

## Healer Alpha (MANAGER)

### Role
Position management and exits - the "healer" that maintains and closes positions.

### Schedule
Runs every `managementIntervalMin` minutes (default: 10 minutes)

### Toolset

**Read-Only Tools** (all):
- `get_my_positions` - Get all open positions
- `get_position_pnl` - Get position PnL
- `get_pool_detail` - Get pool metadata
- `get_pool_memory` - Get pool history
- `get_pool_history` - Get pool historical metrics
- `get_performance_history` - Get performance history
- `get_recent_decisions` - Get decisions
- `get_wallet_balance` - Get wallet balances
- `get_portfolio_risk` - Get portfolio risk metrics
- `check_smart_wallets_on_pool` - Check smart wallets

**Write Tools**:
- `deploy_position` - Deploy new position
- `claim_fees` - Claim fees
- `close_position` - Close position
- `rebalance_position` - Close and redeploy
- `compound_fees` - Claim and auto-redeploy
- `add_liquidity_to_position` - Add liquidity
- `swap_token` - Swap tokens
- `clean_dust_tokens` - Clean dust

**Meta Tools**:
- `update_config` - Update configuration
- `add_to_blacklist` - Add to blacklist
- `set_position_note` - Set position instruction
- `add_pool_note` - Add pool note

### Decision Process

**Step 1: Fetch Positions**
```javascript
const positions = await getMyPositions({ force: true })
```
- Fetches all open positions
- Includes live PnL, unclaimed fees, range status

**Step 2: Fetch PnL Per Position**
```javascript
for (const position of positions) {
  const pnl = await getPositionPnl({
    pool_address: position.pool,
    position_address: position.position
  })
  // Combine with position data
}
```
- Gets detailed PnL for each position
- Includes unclaimed fees, fees total, in_range status

**Step 3: Check Deterministic Rules**
```javascript
for (const position of positionData) {
  const exit = updatePnlAndCheckExits(position.position, position, mgmtConfig)
  if (exit) {
    // Deterministic exit
    actionMap.set(position.position, { action: "CLOSE", reason: exit.reason })
  }
}
```

Checks:
- Confirmed stop loss
- Confirmed trailing TP
- Confirmed IL stop
- OOR > wait minutes
- Trailing TP triggered
- Stop loss triggered
- Low yield
- Volume decay
- IL stop triggered

**Step 4: Execute Deterministic Actions**
```javascript
for (const position of deterministicPositions) {
  if (action === "CLOSE") {
    await closePosition({ position_address, reason })
  } else if (action === "CLAIM") {
    await claimFees({ position_address })
  } else if (action === "RECOMPOUND") {
    // Claim fees + add X token back
  }
}
```

**Step 5: Evaluate Instructions**
```javascript
const instructionPositions = positionData.filter(p => p.instruction)
const result = await agentLoop(instructionGoal, maxSteps, [], "MANAGER")
```

**Step 6: Auto-Swap After Close**
```javascript
// After any close, check for base tokens and swap to SOL
if (!args.skip_swap && result.base_mint) {
  const token = balances.tokens?.find(t => t.mint === result.base_mint)
  if (token && token.usd >= 0.10) {
    await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance })
  }
}
```

### Key Behaviors

**BIAS TO HOLD**:
- Unless position is dying
- Unless volume collapsed
- Unless yield vanished
- Unless instruction fires

**Instruction Priority**:
1. Instruction condition checked FIRST
2. If met → close immediately
3. BIAS_TO_HOLD does NOT apply when instruction fires

**Post-Close Auto-Swap**:
- All base tokens auto-swapped to SOL
- Skip tokens worth < $0.10 (dust)
- Prevents wallet getting full of small positions

**Recompound Rule**:
- If single-sided + deep in position
- Claim fees
- Add X token back to position
- Only if cooldown passed

**Low Yield Exit**:
- Position age > 60 minutes
- Fee/TVL < 7%
- Close to redeploy elsewhere

**Diversification Check**:
- Call get_portfolio_risk
- If any token > 20% of portfolio → skip new deploys
- Consider closing weakest position

### Configuration

```json
{
  "management": {
    "minClaimAmount": 5,
    "autoSwapAfterClaim": false,
    "outOfRangeWaitMinutes": 30,
    "trailingTakeProfit": true,
    "trailingTriggerPct": 3,
    "trailingDropPct": 1.5,
    "stopLossPct": -50,
    "takeProfitPct": 5,
    "minFeePerTvl24h": 7,
    "minAgeBeforeYieldCheck": 60,
    "deployAmountSol": 0.5,
    "gasReserve": 0.2,
    "positionSizePct": 0.35,
    "dynamicILStop": false,
    "ilRecoveryMaxDays": 3,
    "ilStopMinPct": -3,
    "feeRateDecayEnabled": true,
    "feeRateDropPct": 60,
    "volumeDecayEnabled": true,
    "volumeDecayPct": 70,
    "recompoundEnabled": true,
    "recompoundCooldownMinutes": 60,
    "solMode": false
  }
}
```

### Agent Prompt Highlights

**Mechanical Rule Application**:
- Position data pre-loaded
- Apply close/claim rules directly
- No extended analysis required

**Deterministic Rules**:
- OOR wait: volatility<3 ? 30 : 15 minutes
- Trailing stop: trigger at +4% PnL, close at +2%
- Hard stop-loss: close if PnL < -25%
- Dynamic IL stop: if IL > fees can recover → close
- Auto-claim: if unclaimed_fees_usd > $1.00 → claim + compound
- Low-yield exit: if age>120min + fee_tvl<5% → close
- Diversification: if any token >20% portfolio → skip new deploys

**Post-Close Actions**:
- Swap base tokens back to SOL
- Check for dust tokens (< $0.10 = skip)
- Always check token USD value before swapping

**LLM Evaluation**:
- Only for instruction evaluation
- If instruction condition met → close
- Otherwise → BIAS_TO_HOLD