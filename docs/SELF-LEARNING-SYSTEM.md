# Self-Learning System

## Overview

Meridian uses a three-pronged approach to improve over time:
1. **Performance-based lessons** - Extract insights from wins/losses
2. **Adaptive thresholds** - Evolve screening criteria based on results
3. **Darwinian signal weighting** - Learn which signals predict success

## Performance Analysis

### Outcome Categories

| PnL | Fee Yield | Outcome |
|-----|-----------|---------|
| >= +5% | Any | good |
| >= 0% | >= 2% | good |
| >= 0% | < 2% | neutral |
| >= -5% | Any | poor |
| < -5% | Any | bad |

Neutral outcomes don't generate lessons (nothing to learn).

### Lesson Generation

**Good Outcomes**
- "WORKED: X with strategy=Y, volatility=Z → PnL +A%"
- Tags: worked, strategy, volatility
- Confidence: 0.78-0.82

**Bad Outcomes**
- OOR pattern: "AVOID: X with strategy=Y — went OOR 70% of the time"
- Volume collapse: "AVOID: pools with low fees that showed volume collapse"
- General failure: "FAILED: X → PnL -A% reason=..."
- Tags: failed, oor, volume_collapse
- Confidence: 0.68-0.88

### Lesson Storage

Lessons include:
- Rule (actionable insight)
- Tags (for filtering)
- Outcome (good/neutral/bad/poor/failed)
- Source type (performance/manual/config_change)
- Confidence level
- Context (pool, strategy, volatility, etc.)
- PnL and fees data
- Pool address for recall

## Adaptive Thresholds

### Evolution Process

Every 5 closed positions, the system analyzes performance and evolves screening thresholds.

**1. Volatility Ceiling**
- If losers cluster at higher volatility → tighten ceiling
- If all winners span higher volatility → loosen ceiling
- Target: loser 25th percentile + 15% buffer

**2. Fee/TVL Floor**
- If lowest winner fee > current floor * 1.2 → raise floor
- If losers have consistently lower fees → raise floor
- Target: slightly below lowest winner

**3. Organic Score Floor**
- If winner avg organic - loser avg organic >= 10 → raise floor
- Target: just below worst winner organic score

**Constraints**
- Max 20% change per step
- Must have signal in both directions
- Changes logged to user-config.json and lessons.json

### Example Evolution

```
Before: minFeeActiveTvlRatio=0.05, minOrganic=60, maxVolatility=5
After:  minFeeActiveTvlRatio=0.08, minOrganic=65, maxVolatility=4.5
```

## Darwinian Signal Weighting

### What Is Signal Weighting?

Signal weighting learns which screening criteria actually predict profitable positions:
- Signals in winners get boosted
- Signals in losers get decayed
- Weights evolve over time as the agent learns

### Algorithm

**1. Data Collection**
- Filter performance to rolling window (default 60 days)
- Separate wins (PnL > 0) and losses (PnL <= 0)

**2. Lift Computation**
- **Numeric signals**: Normalize values, compare win/loss means
- **Boolean signals**: Compare win rate when present vs absent
- **Categorical signals**: Compare win rates across categories
- Higher lift = more predictive of success

**3. Weight Updates**
- Top quartile of lift → boost by 1.05
- Bottom quartile of lift → decay by 0.95
- Clamp between 0.3 and 2.5

**4. Recalculation Schedule**
- Every N closes (configurable, default 5)
- Uses config.darwin.recalcEvery

### Signal Types

**Numeric** (higher = better, except volatility)
- organic_score
- fee_tvl_ratio
- volume
- mcap
- holder_count

**Boolean**
- smart_wallets_present

**Categorical**
- narrative_quality

**Reversed**
- volatility (higher = worse)

### Example Weight Changes

```
Signal              Before  After  Action
organic_score       1.00    1.35   boost
fee_tvl_ratio       1.00    1.20   boost
volume              1.00    1.10   boost
mcap                1.00    1.00   stable
holder_count        1.00    1.00   stable
smart_wallets       1.00    0.80   decay
narrative_quality   1.00    1.10   boost
study_win_rate      1.00    1.20   boost
hive_consensus      1.00    1.00   stable
volatility          1.00    1.50   boost (higher = worse)
```

## Lesson Injection

### Prioritization

Lessons are injected into the system prompt with three tiers:

1. **Pinned** (always injected, up to 5/10)
   - Manually pinned by user
   - Critical insights

2. **Role-matched** (up to 6/15)
   - Lessons tagged for this agent type
   - SCREENER: screening/deployment lessons
   - MANAGER: position management lessons

3. **Recent** (fill remaining, up to 10/35)
   - Most recent lessons
   - Fill slots after pinned and role-matched

### Example Prompt Injection

```
LESSONS LEARNED:

[PINNED] PREFER: pools with organic_score>=80 and fee_tvl>=0.1
[SCREENER] WORKED: ROCKET-SOL with strategy=bid_ask, volatility=2.5 → PnL +5.2%
[MANAGER] AVOID: positions that stay OOR >30 minutes before closing
[MANAGER] CLAIM: If unclaimed_fees_usd > $1, claim immediately
[RECENT] WORKED: ANIME-SOL with strategy=spot, volatility=2.45 → PnL +3.26%
```

## Self-Tuning Configuration

### What Gets Self-Tuned

1. **Management Interval**
   - Set after each deploy based on volatility
   - Volatility >= 5 → 3 minutes
   - Volatility 2-5 → 5 minutes
   - Volatility < 2 → 10 minutes

2. **Screening Thresholds**
   - Evolved every 5 closed positions
   - Gradual adjustments (max 20% per step)

3. **Signal Weights**
   - Recalculated every N closes
   - Learned from actual performance

### Logging

All changes are:
1. Printed to console
2. Saved to user-config.json
3. Logged to lessons.json
4. Sent to Telegram (if enabled)

### Reverting Changes

To revert self-tuned changes:
1. Edit user-config.json manually
2. Restart agent
3. Changes are persisted in config

## HiveMind Integration

### What's Shared

**Lessons**:
- Rule, tags, outcome, confidence
- Context, PnL, fees
- **No**: Wallets, balances, private keys

**Performance**:
- Pool address, strategy
- PnL, fees, hold time
- Close reason
- **No**: Wallet addresses, balances

**Configuration**:
- Screening thresholds
- Strategy settings
- **No**: API keys, private data

### What's Received

**Pool Consensus**:
- X agents deployed here
- Y% win rate across agents

**Strategy Rankings**:
- Which strategies actually work
- Performance by strategy

**Pattern Consensus**:
- What works at different volatility levels
- What works with different fee/TVL ratios

**Threshold Medians**:
- What other agents evolved to
- Cross-agent consensus

### Safety

- Non-blocking (if HiveMind down, agent continues)
- All text sanitized
- Field lengths limited
- No sensitive data sent