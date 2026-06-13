# Meridian Solana DLMM LP Agent - Comprehensive Documentation

## 1. Project Overview

**Meridian** is an autonomous Meteora DLMM (Dynamic Low Volatility Market Maker) liquidity provider agent for Solana. It operates as a ReAct (Reasoning + Acting) agent that continuously screens pools, manages positions, and learns from performance.

### Key Capabilities

- **Autonomous Pool Screening**: Continuously scans Meteora DLMM pools for high-quality opportunities based on configurable thresholds
- **Position Management**: Opens, monitors, and closes LP positions autonomously based on PnL, yield, and risk signals
- **Fee Harvesting**: Automatically claims fees when thresholds are met
- **Self-Learning System**: Uses structured lessons to improve decision quality over time
- **HiveMind Integration**: Optional collective intelligence system that shares lessons with other agents
- **Telegram Interface**: Full agent control and notifications via Telegram
- **Performance Tracking**: Detailed performance auditing and reporting

### Architecture Pattern

Meridian uses a **dual-agent architecture** with specialized agents running on independent schedules:

| Agent | Role | Default Interval |
|-------|------|------------------|
| Hunter Alpha | Pool screening and deployment | 30 minutes |
| Healer Alpha | Position management and exits | 10 minutes |

Both agents are powered by LLMs via OpenRouter (or any OpenAI-compatible endpoint) and use tool calling to interact with Solana on-chain data and execute actions.
## 2. Architecture

### Core Components

```
index.js          — Main entry point, cron scheduling, cycle orchestration
agent.js          — ReAct agent loop, tool execution, role-based configuration
config.js         — Configuration management with user-config.json
state.js          — Persistent state tracking (positions, events, signals)
lessons.js        — Learning system, performance analysis, threshold evolution
pool-memory.js    — Deploy history and cooldowns per pool
signal-weights.js — Darwinian signal weighting for screening prioritization
hivemind.js       — Collective intelligence system
briefing.js       — Morning reporting generation
logger.js         — Logging with daily rotation
prompt.js         — Dynamic system prompt generation
```

### Data Flow

```
Screening Cycle:
1. discoverPools() → Meteora Pool Discovery API
2. Filter by thresholds (fee/TVL, volume, organic, etc.)
3. Enrich with pool history, OKX data, DexScreener data
4. Call agentLoop(SCREENER) → pick best candidate
5. deployPosition() → On-chain transaction
6. Record performance to state.json and lessons.json

Management Cycle:
1. getMyPositions() → Meteora Portfolio API
2. getPositionPnl() → Meteora PnL API (for each position)
3. Check deterministic rules (OOR wait, trailing TP, stop loss, etc.)
4. Call agentLoop(MANAGER) for instruction evaluation
5. Execute deterministic actions (CLOSE, CLAIM, RECOMPOUND)
6. Auto-swap base tokens back to SOL after close
7. Update state.json and pool-memory.json
```

### Agent Roles

**SCREENER (Hunter Alpha)**
- Screens pool candidates against thresholds
- Studies top LPers in candidate pools
- Makes deploy/skip decisions
- Uses `hunter-alpha` model by default

**MANAGER (Healer Alpha)**
- Evaluates open positions for action
- Applies deterministic exit rules (trailing TP, stop loss, OOR, low yield)
- Handles instructions set by user or system
- Uses `healer-alpha` model by default

**GENERAL**
- Used for REPL/chat interactions
- Handles user commands and questions
- Uses `healer-alpha` model by default

### State Management

Meridian maintains three primary state files:

1. **state.json** - Tracked position metadata:
   - Deploy time, strategy, bin configuration
   - Out-of-range timestamps
   - Pending confirmations (trailing TP, stop loss, IL stop)
   - Fee claim history

2. **lessons.json** - Agent learning records:
   - Manual lessons (operator-input)
   - Performance-derived lessons
   - Threshold evolution history
   - Performance records (pnl, fees, win rate)

3. **pool-memory.json** - Pool-specific history:
   - Deploy counts and win rates
   - Cooldown tracking (pool and token-level)
   - Position snapshots (trend data)
   - Notes per pool

### Data Stores

| File | Purpose |
|------|---------|
| `state.json` | Position metadata, OOR tracking, pending exits |
| `lessons.json` | Agent knowledge base, performance records |
| `pool-memory.json` | Deploy history, cooldowns, snapshots |
| `signal-weights.json` | Darwinian signal weights |
| `db/meridian.db` | SQLite for lessons, performance, smart wallets |
| `state/state.json` | Runtime state snapshot |
## 3. Core Modules

### index.js (Main Entry Point)

Main orchestrator that:
- Initializes agents, configuration, and logging
- Sets up cron jobs for management and screening cycles
- Manages cycle state (busy flags, cooldowns)
- Implements pending exit confirmations with recheck timers
- Handles Telegram cycle reports and live messages
- Provides REPL interface for manual control

Key functions:
- `runManagementCycle()` - Evaluates and manages open positions
- `runScreeningCycle()` - Screens pools and deploys
- `runBriefing()` - Generates morning performance report
- `schedulePeakConfirmation()` - Trailing TP recheck mechanism
- `scheduleTrailingDropConfirmation()` - Trailing exit recheck
- `scheduleStopLossConfirmation()` - Stop loss recheck
- `scheduleILStopConfirmation()` - Impermanent loss stop recheck

### agent.js (ReAct Agent Loop)

Core agent implementation with these features:

**Tool Classification**
- **READ_ONLY_TOOLS**: Non-mutating calls (get_my_positions, get_top_candidates, etc.)
- **WRITE_TOOLS_AGENT**: On-chain state mutations (deploy_position, close_position, swap_token)
- **MANAGER_TOOLS**: Full access including config updates and pool notes
- **SCREENER_TOOLS**: Read + deploy + config but no full wallet access

**Intent Detection**
Uses regex patterns to match user intent and grant appropriate tools:
- deploy, close, claim, swap, blocklist, config, balance, positions, strategy, etc.

**Safety Mechanisms**
- `ONCE_PER_SESSION` set prevents duplicate tool calls (deploy twice, swap twice)
- `NO_RETRY_TOOLS` prevents retrying destructive operations after first attempt
- Model retry logic for transient errors (502, 503, 529)
- Fallback model switching on provider errors

**Agent Loop Flow**
1. Build dynamic system prompt with current state
2. For each step up to maxSteps:
   - Call LLM with tools available
   - Execute tool calls via executeTool()
   - Add tool results to conversation history
3. Return final text response

### config.js (Configuration)

Configuration structure:
```javascript
{
  risk: { maxPositions, maxDeployAmount },
  screening: { minFeeActiveTvlRatio, minTvl, maxTvl, minVolume, ... },
  management: { stopLossPct, takeProfitPct, trailingDropPct, ... },
  strategy: { strategy, binsBelow },
  schedule: { managementIntervalMin, screeningIntervalMin },
  llm: { defaultModel, managementModel, screeningModel },
  darwin: { enabled, windowDays, boostFactor, decayFactor },
  hiveMind: { url, apiKey, agentId, pullMode }
}
```

Key helper functions:
- `computeDeployAmount(walletSol)` - Scales deploy size with wallet growth
- `computeBinsBelow(volatility)` - Sets bin range based on volatility
- `reloadScreeningThresholds()` - Hot-reload thresholds from user-config.json

### state.js (Persistent State)

Tracks position metadata not available on-chain:
- Deploy timestamps and strategy configuration
- Out-of-range tracking with timestamps
- Pending exit confirmations with 15-second recheck timers
- Entry fee rate and volume for decay checks
- Recent events log (last 20)

Key state functions:
- `trackPosition()` - Register new position
- `markOutOfRange()` / `markInRange()` - OOR status tracking
- `updatePnlAndCheckExits()` - Evaluate all exit conditions
- `queuePeakConfirmation()` / `resolvePendingPeak()` - Trailing TP
- `queueStopLossConfirmation()` / `resolvePendingStopLoss()` - Stop loss
- `queueILStopConfirmation()` / `resolvePendingILStop()` - IL stop
- `setEntryFeeRate()` / `setEntryVolume()` - For decay tracking

### lessons.js (Learning System)

Agent learning infrastructure:

**Performance Recording**
- `recordPerformance(perf)` - Called on position close
- Derives lessons from good/bad outcomes
- Updates pool-memory with deploy record
- Evolves thresholds every MIN_EVOLVE_POSITIONS (5)
- Recalculates signal weights via Darwinian system

**Lesson Types**
- Performance-derived (auto-generated from wins/losses)
- Manual (operator input via Telegram/REPL)
- Config changes (self-tuned thresholds)

**Threshold Evolution**
- Analyzes winners vs losers by volatility, fee/TVL, organic score
- Gradually tightens or loosens thresholds
- Never changes more than MAX_CHANGE_PER_STEP (20%) at once

### pool-memory.js (Deploy History)

Pool-specific historical data:
- Total deploys and win rates (including adjusted for OOR)
- Cooldown tracking (pool-level and base mint-level)
- Position snapshots for trend analysis
- Notes per pool

Cooldown triggers:
- **Low yield**: 4-hour cooldown after low fee/TVL close
- **Repeated OOR**: 12-hour cooldown after 3 OOR closes
- **Consecutive losses**: 8-hour cooldown after 2 negative closes

### signal-weights.js (Darwinian Signal Weighting)

Adapts screening priorities based on actual performance:

**Signals Tracked**
- organic_score, fee_tvl_ratio, volume, mcap, holder_count
- smart_wallets_present, narrative_quality, study_win_rate
- hive_consensus, volatility

**Algorithm**
1. Filter recent performance data (default 60-day window)
2. Compute predictive lift for each signal (higher values → better outcomes)
3. Split signals into quartiles based on lift
4. Boost top quartile by boostFactor (1.05)
5. Decay bottom quartile by decayFactor (0.95)
6. Clamp weights between weightFloor (0.3) and weightCeiling (2.5)

**Output**
- Human-readable summary for LLM injection
- Weight changes logged and persisted
## 4. Agents

### Hunter Alpha (SCREENER)

**Role**: Pool screening and deployment

**Schedule**: Every screeningIntervalMin minutes (default 30)

**Toolset**
- Read-only tools (get_my_positions, get_top_candidates, get_pool_detail)
- deploy_position (to open new positions)
- skip_deploy (to opt out)
- add_pool_note, add_to_blacklist, update_config

**Decision Process**
1. Fetch top candidates from Meteora Pool Discovery API
2. Enrich with:
   - Pool history (prior outcomes, signal snapshots)
   - OKX advanced info (risk flags, bundle %, smart money)
   - DexScreener raw data (price change, txns, volume)
   - Discord signals (if enabled)
3. Filter out blacklisted tokens, blocked devs, PVP rivals
4. Call LLM to evaluate candidates
5. Select best candidate and deploy

**LLM Prompt Highlights**
- Emphasizes patience and gas efficiency
- Warns about untrusted data (narratives, pool notes)
- Provides structured history analysis before deploy
- Includes signal weights summary for prioritization

### Healer Alpha (MANAGER)

**Role**: Position management and exits

**Schedule**: Every managementIntervalMin minutes (default 10)

**Toolset**
- All read-only tools
- All write tools (deploy_position, close_position, claim_fees, swap_token, rebalance_position, compound_fees)
- Config management tools (update_config, add_to_blacklist)
- Performance tracking tools (get_performance_history, get_pool_history)

**Decision Process**
1. Fetch current positions and PnL data
2. Evaluate deterministic rules (no LLM needed):
   - Out-of-range wait timer
   - Trailing TP (peak PnL + drop threshold)
   - Stop loss (hard PnL threshold)
   - Low yield (fee/TVL decay)
   - Volume decay (entry vs current volume)
   - IL stop (impermanent loss recovery time)
3. Execute deterministic actions directly
4. Evaluate instruction-based positions with LLM
5. After any close, auto-swap base tokens to SOL

**LLM Prompt Highlights**
- Mechanical rule application task
- High priority for instruction conditions
- BIAS_TO_HOLD guidance (hold unless clear reason to exit)
- Post-close auto-swap reminder
- Diversification checks via get_portfolio_risk

### Agent Behavior Patterns

**Safety Defaults**
- Maximum 20 steps per agent loop
- Retry up to 3 times on transient errors
- Fallback to default model on repeated errors
- Block duplicate destructive tool calls
- Force tool calls for action intents

**Telegram Integration**
- Sends cycle reports after each cycle
- Out-of-range alerts when OOR exceeds threshold
- Telegram notifications for deploy, close, swap, dust cleanup
- Full chat interface for user commands
## 5. Data Stores

### state.json

Persistent position metadata stored at project root:

```json
{
  "positions": {
    "[position_address]": {
      "position": "...",
      "pool": "...",
      "pool_name": "TOKEN-SOL",
      "strategy": "bid_ask",
      "bin_range": { "min": -400, "max": -350, "bins_below": 50, "bins_above": 0 },
      "amount_sol": 0.5,
      "amount_x": 0,
      "active_bin_at_deploy": -350,
      "bin_step": 100,
      "volatility": 3.5,
      "organic_score": 85,
      "initial_value_usd": 50,
      "signal_snapshot": { ... },
      "deployed_at": "2026-04-01T12:00:00Z",
      "out_of_range_since": null,
      "last_claim_at": null,
      "total_fees_claimed_usd": 0,
      "rebalance_count": 0,
      "closed": false,
      "closed_at": null,
      "notes": [],
      "peak_pnl_pct": 0,
      "pending_peak_pnl_pct": null,
      "pending_trailing_current_pnl_pct": null,
      "pending_stop_loss_pnl_pct": null,
      "pending_il_stop_il_pct": null,
      "entry_fee_rate": 0.00123,
      "entry_volume": 10000
    }
  },
  "recent_events": [
    { "ts": "2026-04-01T12:00:00Z", "action": "deploy", "position": "...", ... }
  ],
  "last_updated": "2026-04-01T12:00:00Z"
}
```

### lessons.json

Agent knowledge base with two main sections:

```json
{
  "lessons": [
    {
      "id": 1712000000000,
      "rule": "AVOID: pool-name with strategy=bid_ask when volatility>4 — went OOR 70% of the time",
      "tags": ["oor", "bid_ask", "volatility_4"],
      "outcome": "bad",
      "sourceType": "performance",
      "confidence": 0.82,
      "context": "pool-name, strategy=bid_ask, bin_step=100, volatility=4.2",
      "pnl_pct": -12.5,
      "fees_earned_usd": 0.5,
      "initial_value_usd": 50,
      "range_efficiency": 30,
      "close_reason": "out of range",
      "pool": "pool_address",
      "created_at": "2026-04-01T12:00:00Z"
    },
    {
      "id": 1712000000001,
      "rule": "PREFER: pools with organic_score>=80 and fee_tvl>=0.1",
      "tags": ["organic", "worked"],
      "outcome": "good",
      "confidence": 0.78,
      "pinned": true,
      "role": "SCREENER",
      "created_at": "2026-04-01T12:00:00Z"
    }
  ],
  "performance": [
    {
      "position": "...",
      "pool": "...",
      "pool_name": "TOKEN-SOL",
      "strategy": "bid_ask",
      "volatility": 3.5,
      "fee_tvl_ratio": 0.12,
      "organic_score": 85,
      "amount_sol": 0.5,
      "fees_earned_usd": 2.5,
      "final_value_usd": 51.2,
      "initial_value_usd": 50,
      "minutes_in_range": 120,
      "minutes_held": 180,
      "close_reason": "trailing_tp",
      "pnl_usd": 2.5,
      "pnl_pct": 5,
      "range_efficiency": 66.7,
      "signal_snapshot": { ... },
      "recorded_at": "2026-04-01T12:00:00Z"
    }
  ]
}
```

### pool-memory.json

Deploy history and cooldown tracking:

```json
{
  "pool_address": {
    "name": "TOKEN-SOL",
    "base_mint": "token_mint...",
    "deploys": [
      {
        "deployed_at": "2026-04-01T12:00:00Z",
        "closed_at": "2026-04-01T14:00:00Z",
        "pnl_pct": 5,
        "pnl_usd": 2.5,
        "range_efficiency": 66.7,
        "minutes_held": 120,
        "close_reason": "trailing_tp",
        "strategy": "bid_ask",
        "volatility_at_deploy": 3.5
      }
    ],
    "total_deploys": 1,
    "avg_pnl_pct": 5,
    "win_rate": 100,
    "adjusted_win_rate": 100,
    "adjusted_win_rate_sample_count": 1,
    "last_deployed_at": "2026-04-01T14:00:00Z",
    "last_outcome": "profit",
    "cooldown_until": null,
    "cooldown_reason": null,
    "base_mint_cooldown_until": null,
    "base_mint_cooldown_reason": null,
    "notes": [],
    "snapshots": [
      {
        "ts": "2026-04-01T12:30:00Z",
        "position": "...",
        "pnl_pct": 2.5,
        "in_range": true,
        "unclaimed_fees_usd": 1.2,
        "minutes_out_of_range": 0
      }
    ]
  }
}
```

### signal-weights.json

Darwinian signal weighting data:

```json
{
  "weights": {
    "organic_score": 1.35,
    "fee_tvl_ratio": 1.2,
    "volume": 1.1,
    "mcap": 1.0,
    "holder_count": 1.0,
    "smart_wallets_present": 0.8,
    "narrative_quality": 1.1,
    "study_win_rate": 1.2,
    "hive_consensus": 1.0,
    "volatility": 1.5
  },
  "last_recalc": "2026-04-01T12:00:00Z",
  "recalc_count": 5,
  "history": [
    {
      "timestamp": "2026-04-01T12:00:00Z",
      "changes": [
        { "signal": "volatility", "from": 1.0, "to": 1.5, "lift": 0.45, "action": "boosted" }
      ],
      "window_size": 15,
      "win_count": 10,
      "loss_count": 5
    }
  ]
}
```
## 6. Tools/Integrations

### Meteora DLMM SDK (@meteora-ag/dlmm)

**Purpose**: On-chain position management and data fetching

**Key Functions**
- `DLMM.create()` - Initialize pool instance
- `pool.getActiveBin()` - Get current active bin
- `pool.initializePositionAndAddLiquidityByStrategy()` - Deploy standard position
- `pool.createExtendedEmptyPosition()` - Deploy wide range (>69 bins)
- `pool.addLiquidityByStrategyChunkable()` - Add liquidity to wide range positions
- `pool.closePosition()` - Close position
- `pool.claimFees()` - Claim fees

**Implementation Notes**
- Lazy loading to avoid CJS/ESM conflicts
- Dynamic import after wallet configuration
- Wide range positions require chunkable transactions
- Position initialization and liquidity addition may require multiple transactions

### Meteora Data API

**DLMM Portfolio API**
- `GET https://dlmm.datapi.meteora.ag/portfolio/open?user={wallet}`
- Returns all open positions with pool metadata

**DLMM PnL API**
- `GET https://dlmm.datapi.meteora.ag/positions/{pool}/pnl?user={wallet}`
- Returns position PnL, unclaimed fees, range data

**Pool Discovery API**
- `GET https://pool-discovery-api.datapi.meteora.ag/pools`
- Filter by multiple criteria (fee/TVL, volume, TVL, volatility, etc.)
- Timeframe-weighted metrics

### Helius Wallet API

**Purpose**: Get wallet balances

**Endpoint**
- `GET https://api.helius.xyz/v1/wallet/{wallet}/balances?api-key={key}`

**Cache**: 3-minute cache to save API credits (100 credits per call)

### Jupiter APIs

**Swap V2 API**
- `POST https://api.jup.ag/swap/v2/order` - Get unsigned swap transaction
- `POST https://api.jup.ag/swap/v2/execute` - Execute signed transaction

**Price API**
- `GET https://api.jup.ag/price/v3` - Token prices

**Ultra API**
- `GET https://api.jup.ag/ultra/v1` - Advanced routing

**Quota**: 1000 requests/minute per API key

### OKX Advanced Info

**Purpose**: Token risk assessment

**Endpoints**:
- `https://www.okx.com/priapi/v1/markets/advanced-info/{mint}` - Risk flags, bundle %, sniper %
- `https://www.okx.com/priapi/v1/markets/price-info/{mint}` - ATH price, price vs ATH
- `https://www.okx.com/priapi/v1/markets/clusters/list/{mint}` - Cluster list with KOL presence
- `https://www.okx.com/priapi/v1/markets/risk/flags/{mint}` - Risk flags (rugpull, wash)

**No API key required** - Uses standard headers

### DexScreener

**Purpose**: Token-wide price and transaction data

**Endpoints**:
- `https://api.dexscreener.com/latest/dex/tokens/{mint}` - Token pairs
- `https://api.dexscreener.com/latest/dex/search?q={query}` - Search

**Data Included**:
- Price change (5m, 15m, 1h, 4h, 24h)
- Transaction counts (buys/sells)
- Volume
- Liquidity
- FDV

### Discord Signals

**Purpose**: Get pool candidates from Agent Meridian Discord

**Endpoint**
- `GET https://api.agentmeridian.xyz/api/signals/discord/candidates`

**Modes**:
- `merge` - Combine with discovery API candidates
- `only` - Use only Discord signals

### HiveMind (Optional)

**Purpose**: Collective intelligence sharing

**Endpoints**:
- `POST /api/hivemind/agents/register` - Register agent
- `GET /api/hivemind/lessons/pull` - Pull shared lessons
- `POST /api/hivemind/lessons/push` - Push new lessons
- `GET /api/hivemind/presets/pull` - Pull presets
- `POST /api/hivemind/performance/push` - Push performance data

**What's Shared**:
- Lessons from lessons.json
- Deploy outcomes with PnL
- Screening thresholds
- **NO sensitive data** (wallets, private keys, balances)

### Telegram

**Purpose**: Notifications and chat interface

**Features**:
- Cycle reports (management and screening)
- Out-of-range alerts
- Deploy/close/swap/dust cleanup notifications
- Full chat interface for commands
- Live cycle messages (progress indicators)

**Security**:
- Chat ID and allowed user IDs must be set in .env
- No auto-registration (safety by default)
- Inbound control limited to allowed user IDs

### OpenRouter / LLM

**Purpose**: Agent reasoning and tool calling

**Supported Endpoints**:
- OpenRouter (default): `https://openrouter.ai/api/v1`
- Local LLM (LM Studio, Ollama): Any OpenAI-compatible endpoint

**Models by Role**:
- **SCREENER**: hunter-alpha (config.screeningModel)
- **MANAGER**: healer-alpha (config.managementModel)
- **GENERAL**: healer-alpha (config.generalModel)

**Configuration**:
```javascript
{
  temperature: 0.373,
  maxTokens: 4096,
  maxSteps: 20,
  defaultModel: "openrouter/healer-alpha",
  managementModel: "openrouter/healer-alpha",
  screeningModel: "openrouter/hunter-alpha",
  generalModel: "openrouter/healer-alpha"
}
```
## 7. Learning System

### Two-Phase Learning

Meridian uses a two-phase learning approach:

#### Phase 1: Performance Analysis (Lessons)

When a position closes, `recordPerformance()`:
1. Calculates PnL and range efficiency
2. Determines outcome category (good/neutral/bad)
3. Derives a lesson if outcome is notable:
   - **Good**: "WORKED: X with strategy=Y → PnL +Z%"
   - **Bad**: "FAILED: X with strategy=Y → PnL -Z% reason=..."
   - **OOR**: "AVOID: X-type pools with strategy=Y — went OOR 70% of the time"
4. Saves to lessons.json
5. Updates pool-memory with deploy record

#### Phase 2: Threshold Evolution

Every 5 closed positions, `evolveThresholds()`:
1. Separates winners (PnL > 0) and losers (PnL < -5%)
2. Analyzes distribution of key signals:
   - Volatility (losers cluster at high vol → tighten ceiling)
   - Fee/TVL ratio (losers have low fees → raise floor)
   - Organic score (losers have low organic → raise floor)
3. Gradually adjusts thresholds (max 20% per step)
4. Persists changes to user-config.json
5. Logs a self-tuned lesson

### Darwinian Signal Weighting

**Process**:
1. Collect recent performance data (default 60-day window)
2. Filter to wins and losses
3. For each signal, compute predictive lift:
   - **Numeric**: Normalize values, compare win/loss means
   - **Boolean**: Compare win rate when present vs absent
   - **Categorical**: Compare win rates across categories
4. Rank signals by lift
5. Split into quartiles:
   - Top quartile → boost by 1.05
   - Bottom quartile → decay by 0.95
6. Clamp weights between 0.3 and 2.5
7. Persist to signal-weights.json

**Signals Tracked**:
- organic_score, fee_tvl_ratio, volume, mcap, holder_count
- smart_wallets_present, narrative_quality, study_win_rate
- hive_consensus, volatility

### Self-Tuning Configuration

The agent can self-update its configuration:
1. After deploy, updates management interval based on volatility
2. Threshold evolution adjusts screening thresholds
3. Signal weight recalc updates prioritization

All changes are:
- Logged to console
- Saved to user-config.json
- Added to lessons.json for transparency

### Lesson Injection

Lessons are injected into the system prompt with tiered priority:
1. **Pinned**: Always injected (up to 5/10 depending on cycle)
2. **Role-matched**: Lessons tagged for this agent type
3. **Recent**: Fill remaining slots (up to 10/35 depending on cycle)

This ensures:
- Critical lessons are always seen
- Role-specific guidance takes precedence
- Agent has access to learning history

### HiveMind Integration

**What's Shared**:
- Lessons (with confidence, tags, outcome)
- Deploy outcomes (pool, strategy, PnL, fees, hold time)
- Screening thresholds

**What's Shared**:
- Agent ID (anonymous)
- Performance metrics (no wallet addresses)
- Learning patterns

**Benefits**:
- Pool consensus (X agents deployed, Y% win rate)
- Strategy rankings (what actually works across agents)
- Threshold medians (what other agents evolved to)
## 8. Configuration

### user-config.json

All configuration is stored in `user-config.json`. Fields are optional with sensible defaults.

```json
{
  "maxPositions": 3,
  "maxDeployAmount": 50,
  "deployAmountSol": 0.5,
  "minSolToOpen": 0.55,
  "gasReserve": 0.2,
  "positionSizePct": 0.35,
  "minClaimAmount": 5,
  "autoSwapAfterClaim": false,
  "trailingTakeProfit": true,
  "trailingTriggerPct": 3,
  "trailingDropPct": 1.5,
  "stopLossPct": -50,
  "takeProfitPct": 5,
  "outOfRangeWaitMinutes": 30,
  "oorCooldownTriggerCount": 3,
  "oorCooldownHours": 12,
  "dynamicILStop": false,
  "ilRecoveryMaxDays": 3,
  "ilStopMinPct": -3,
  "minFeePerTvl24h": 7,
  "minAgeBeforeYieldCheck": 60,
  "recompoundEnabled": true,
  "recompoundCooldownMinutes": 60,
  "feeRateDecayEnabled": true,
  "feeRateDropPct": 60,
  "minFeesBeforeFeeRateExit": 0.5,
  "volumeDecayEnabled": true,
  "volumeDecayPct": 70,
  "minFeesBeforeExit": 0.5,
  "dustThresholdUsd": 0.1,
  "solMode": false,
  "silentMode": false,
  "managementIntervalMin": 10,
  "screeningIntervalMin": 30,
  "healthCheckIntervalMin": 60,
  "dustCleanupIntervalHours": 6,
  "pnlPollIntervalSec": 15,
  "temperature": 0.373,
  "maxTokens": 4096,
  "maxSteps": 20,
  "strategy": "bid_ask",
  "binsBelow": 69,
  "darwinEnabled": true,
  "darwinWindowDays": 60,
  "darwinRecalcEvery": 5,
  "darwinBoost": 1.05,
  "darwinDecay": 0.95,
  "darwinFloor": 0.3,
  "darwinCeiling": 2.5,
  "darwinMinSamples": 10,
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

### Screening Thresholds

```json
{
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
  "allowedLaunchpads": [],
  "blockedLaunchpads": [],
  "minTokenAgeHours": null,
  "maxTokenAgeHours": null,
  "athFilterPct": null
}
```

### Environment Variables

Required:
```
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=base58_private_key
```

Optional:
```
RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=your_key
TELEGRAM_BOT_TOKEN=123456:ABC
TELEGRAM_CHAT_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=123456789
LPAGENT_API_KEY=lpagent_xxx
DRY_RUN=true
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=openrouter/healer-alpha
LLM_API_KEY=sk-or-...
LOG_LEVEL=info
```

### Dynamic Configuration

The agent can update its own configuration:
1. **Volatility-based interval**: After deploy, sets management interval based on pool volatility
2. **Threshold evolution**: Adjusts screening thresholds every 5 closed positions
3. **Signal weight recalc**: Every N closes (configurable)

Changes are hot-applied without restart.
## 9. CLI Commands

The Meridian CLI is accessible via the `meridian` command (defined in package.json).

### Package Scripts

```json
{
  "setup": "node setup.js",
  "start": "node index.js",
  "backtest": "node test/backtest-sim.js",
  "dev": "DRY_RUN=true node index.js",
  "test:screen": "node test/test-screening.js",
  "test:agent": "DRY_RUN=true node test/test-agent.js",
  "postinstall": "node scripts/patch-anchor.js"
}
```

### REPL Commands

After `npm start`, an interactive prompt is available:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

Commands:
- `1, 2, 3...` - Deploy into that numbered candidate
- `auto` - Let the agent pick the best pool
- `/status` - Refresh wallet balance and positions
- `/candidates` - Re-screen and display candidates
- `/learn` - Study top LPers across candidate pools
- `/learn <pool_address>` - Study top LPers in specific pool
- `/thresholds` - Show current screening thresholds and stats
- `/evolve` - Trigger threshold evolution (requires 5+ closed positions)
- `/stop` - Graceful shutdown
- `<anything else>` - Free-form chat (agent will respond)

### State Commands

- `get_my_positions` - Fetch current positions
- `get_wallet_balance` - Fetch wallet balances
- `get_active_bin {pool_address}` - Get pool's active bin
- `get_pool_detail {pool_address}` - Get pool metadata

### Management Commands

- `claim_fees {position_address}` - Claim fees for position
- `close_position {position_address}` - Close position
- `rebalance_position {position_address} {new_lower_bin} {new_upper_bin}` - Rebalance

### Utility Commands

- `update_config {key} {value}` - Update configuration
- `add_to_blacklist {mint}` - Blacklist a token
- `remove_from_blacklist {mint}` - Remove from blacklist
- `list_blacklist` - Show blacklisted tokens

### Agent Control

- `trigger_cycle screening` - Manually trigger screening cycle
- `trigger_cycle management` - Manually trigger management cycle
- `self_update` - Pull latest changes and restart

### Learning Commands

- `add_lesson {rule}` - Add a manual lesson
- `pin_lesson {id}` - Pin a lesson (always injected)
- `unpin_lesson {id}` - Unpin a lesson
- `list_lessons` - List all lessons
- `clear_lessons` - Clear all lessons
- `clear_lessons mode=performance` - Clear performance records
- `clear_lessons mode=keyword keyword={search}` - Clear matching lessons
## 10. HiveMind

HiveMind is Meridian's optional collective intelligence system that allows agents to share what they learn with each other.

### How It Works

**Data Shared (Anonymous)**:
- Lessons (with confidence, tags, outcome)
- Deploy outcomes (pool address, strategy, PnL, fees, hold time)
- Screening thresholds
- **No sensitive data**: Wallets, private keys, SOL balances

**Data Received**:
- Pool consensus from other agents
- Strategy rankings across all agents
- Pattern consensus (what works at different volatility)
- Threshold medians (what other agents evolved to)

### Setup

1. Get registration token from private Telegram discussion
2. Register your agent:
   ```bash
   node -e "import('./hivemind.js').then(m => m.register('https://api.agentmeridian.xyz', 'YOUR_TOKEN'))"
   ```
3. Save the API key printed in terminal (will not be shown again)

### Configuration

```json
{
  "hiveMindUrl": "https://api.agentmeridian.xyz",
  "hiveMindApiKey": "your_api_key",
  "agentId": "agt_xxx",
  "hiveMindPullMode": "auto"
}
```

### Pull Modes

- **auto**: Sync on startup and every 15 minutes
- **manual**: Only sync on startup

### Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/hivemind/agents/register | Register agent heartbeat |
| GET | /api/hivemind/lessons/pull | Pull shared lessons |
| GET | /api/hivemind/presets/pull | Pull presets |
| POST | /api/hivemind/lessons/push | Push new lesson |
| POST | /api/hivemind/performance/push | Push position close |

### Safety

- All text is sanitized (flattened whitespace, removed special chars)
- Limits field lengths to prevent prompt injection
- No wallet or balance data sent
- Non-blocking (if HiveMind is down, agent continues normally)
## 11. Security

### Dry-Run Mode

**Environment Variable**: `DRY_RUN=true`

**Behavior**:
- All on-chain transactions are simulated
- No SOL or tokens are spent
- All API calls still execute
- Returns dry_run: true with would_deploy/would_close info

**Use Cases**:
- Testing configuration changes
- Verifying agent behavior
- Development and debugging
- Training data collection

### Safety Checks

**Deploy Protection**:
- Maximum positions limit (config.risk.maxPositions)
- Duplicate pool guard (can't deploy to same pool twice)
- Base token guard (one position per token only)
- Minimum deploy amount check
- Maximum deploy amount check
- SOL balance verification (with gas reserve)

**Transaction Protection**:
- All tool calls go through executeTool()
- PROTECTED_TOOLS include all write operations
- Safety checks run before any write
- Blocked transactions logged and reported

**Rate Limiting**:
- Wallet balance cache: 3-minute TTL (saves Helius credits)
- Pool metadata cache: 15-minute TTL
- Position cache: 5-minute TTL
- No unbounded API calls

### Token Blacklist

**Purpose**: Prevent trading blacklisted tokens

**Sources**:
- Token blacklist file
- Dev blocklist (known malicious developers)
- OKX risk flags (rugpull, wash trading)

**Enforcement**:
- Hard-filtered before LLM sees candidates
- Cooldowns for tokens that caused losses
- Pool-level and token-level cooldowns

### Telegram Security

**Safety by Default**:
- No auto-registration of first chat
- Chat ID must be explicitly set
- Allowed user IDs must be explicitly set for inbound control
- Notifications still go to configured chat
- Command/control only from allowed user IDs

**Best Practices**:
- Use dedicated Telegram bot for agent
- Set allowed user IDs to yourself only
- Don't share bot token publicly
- Use different bots for different agents

### Private Key Handling

**Never Commit**:
- .gitignore includes .env
- .env.example provided for setup
- Private key never sent to LLM
- Private key never logged

**Best Practices**:
- Use environment variables
- Use user-config.json (not committed)
- Use hardware wallet if supported
- Rotate keys periodically
## 12. Setup and Deployment

### Prerequisites

- Node.js 18+
- OpenRouter API key
- Solana wallet (base58 private key)
- Optional: Helius API key, Telegram bot token

### Installation

```bash
git clone <repo-url>
cd dlmm-agent
npm install
```

### Configuration

**1. Create .env**
```bash
cp .env.example .env
# Edit .env with your values
```

Required:
```
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=your_base58_private_key
```

Optional:
```
RPC_URL=https://pump.helius-rpc.com
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ALLOWED_USER_IDS=your_user_id
LPAGENT_API_KEY=your_lpagent_key
DRY_RUN=true
LLM_MODEL=openrouter/healer-alpha
```

**2. Copy Example Config**
```bash
cp user-config.example.json user-config.json
# Edit user-config.json with your preferences
```

### Running

**Development Mode (Dry Run)**
```bash
npm run dev
# No on-chain transactions
```

**Production Mode**
```bash
npm start
# Live trading (transactions submitted to Solana)
```

**Setup Script**
```bash
npm run setup
# Runs setup.js for initial configuration
```

### Monitoring

**Logs**
- Console output with level filtering
- Daily log files in `logs/agent-YYYY-MM-DD.log`
- Action trail in `logs/actions-YYYY-MM-DD.jsonl`

**State Files**
- `state.json` - Position metadata
- `lessons.json` - Agent knowledge base
- `pool-memory.json` - Deploy history
- `signal-weights.json` - Darwinian weights

### Health Checks

**Manual Checks**
- `/status` - Check wallet and positions
- `/candidates` - Check screening results
- `/thresholds` - Check current thresholds

**Automatic Checks**
- Hourly health check cycle
- Morning briefing generation (1:00 AM UTC)

### Troubleshooting

**Wallet Not Configured**
- Ensure WALLET_PRIVATE_KEY is set in .env
- Check key format (base58, 64 characters)

**RPC Errors**
- Verify RPC_URL is accessible
- Check rate limits (Helius, Meteora APIs)

**Agent Not Responding**
- Check logs for errors
- Verify OpenRouter API key is valid
- Check network connectivity

**Telegram Not Working**
- Verify TELEGRAM_BOT_TOKEN is set
- Set TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS
- Test with `/status` command

### Performance Optimization

**Cache Strategy**
- Wallet balance: 3 minutes
- Pool metadata: 15 minutes
- Positions: 5 minutes

**API Usage**
- Use Helius wallet balance instead of RPC calls
- Use Meteora Portfolio API for positions
- Cache candidate lists during screening

**Cost Control**
- Dry run for development
- Monitor API usage
- Adjust cache TTLs if needed
- Use lower model temperature (0.373 default)