# Tool Catalog

## Overview

Meridian agents use tool calling to interact with the world. Each agent type has access to a specific set of tools based on its role.

## Tool Categories

### Read-Only Tools (All Agents)

| Name | Description |
|------|-------------|
| get_my_positions | Get all open positions |
| get_wallet_positions | Get positions for a wallet |
| get_position_pnl | Get PnL and details for a position |
| get_top_candidates | Get top screening candidates |
| get_active_bin | Get pool's active bin |
| get_pool_detail | Get detailed pool metadata |
| discover_pools | Discover pools via filtering |
| search_pools | Search pools by keyword |
| get_token_info | Get token information |
| get_token_holders | Get token holder list |
| get_token_narrative | Get token narrative |
| check_smart_wallets_on_pool | Check if smart wallets are in pool |
| list_smart_wallets | List tracked smart wallets |
| get_top_lpers | Get top LPers in a pool |
| study_top_lpers | Study LPer behavior |
| get_pool_memory | Get deploy history for pool |
| get_cooldown_tokens | Get tokens on cooldown |
| get_pool_history | Get pool's historical metrics |
| get_performance_history | Get position performance history |
| get_recent_decisions | Get recent agent decisions |
| list_lessons | List all agent lessons |
| list_strategies | List available strategies |
| get_strategy | Get strategy details |
| list_blacklist | List blacklisted tokens |
| list_blocked_deployers | List blocked developers |
| get_config | Get current configuration |
| trigger_cycle | Manually trigger screening or management |
| get_wallet_balance | Get wallet balances (Helius API) |
| swap_token | Swap tokens via Jupiter |

### Write Tools (Manager Only)

| Name | Description |
|------|-------------|
| deploy_position | Open new position |
| claim_fees | Claim accumulated fees |
| close_position | Close a position |
| rebalance_position | Close and redeploy with new range |
| compound_fees | Claim fees and auto-redeploy |
| add_liquidity_to_position | Add liquidity to existing position |
| clean_dust_tokens | Clean up small token balances |

### Meta Tools (Manager & Screener)

| Name | Description |
|------|-------------|
| update_config | Update configuration |
| add_to_blacklist | Add token to blacklist |
| remove_from_blacklist | Remove token from blacklist |
| add_pool_note | Add note to pool |
| set_position_note | Set position instruction |
| self_update | Pull latest changes and restart |

### Lesson Management (Manager Only)

| Name | Description |
|------|-------------|
| add_lesson | Add manual lesson |
| pin_lesson | Pin a lesson (always injected) |
| unpin_lesson | Unpin a lesson |
| clear_lessons | Clear all lessons |

## Tool Execution Flow

### 1. Agent Requests Tool

Agent calls tool with arguments:
```json
{
  "name": "deploy_position",
  "arguments": {
    "pool_address": "pool_address...",
    "amount_sol": 0.5,
    "strategy": "bid_ask",
    "bins_below": 69
  }
}
```

### 2. Safety Check

Protected tools (all write operations) go through safety check:
- Deploy: check positions limit, pool not on cooldown, token not on cooldown
- Close: position exists and is open
- Swap: amount > 0, token exists

If safety check fails:
```json
{
  "blocked": true,
  "reason": "Max positions reached"
}
```

### 3. Tool Execution

- Read tool: Direct API call
- Write tool: On-chain transaction (if DRY_RUN=false)
- Return result with success/error status

### 4. Post-Execution Actions

Some tools trigger automatic actions:
- deploy_position: Set management interval based on volatility
- close_position: Auto-swap base token to SOL
- claim_fees: Auto-swap if autoSwapAfterClaim=true
- clean_dust_tokens: Send Telegram notification

## Tool Examples

### get_my_positions

Returns all open positions with live data.

```json
{
  "wallet": "wallet_address...",
  "total_positions": 2,
  "positions": [
    {
      "position": "position_address...",
      "pool": "pool_address...",
      "pair": "ROCKET-SOL",
      "base_mint": "token_mint...",
      "lower_bin": -450,
      "upper_bin": -380,
      "active_bin": -411,
      "in_range": true,
      "unclaimed_fees_usd": 2.35,
      "total_value_usd": 52.15,
      "pnl_usd": 2.15,
      "pnl_pct": 4.2,
      "age_minutes": 120
    }
  ]
}
```

### get_top_candidates

Returns screening candidates with enrichment.

```json
{
  "candidates": [
    {
      "pool": "pool_address...",
      "name": "ROCKET-SOL",
      "base": {
        "symbol": "ROCKET",
        "mint": "token_mint...",
        "organic": 85
      },
      "fee_active_tvl_ratio": 0.12,
      "volume_window": 5000,
      "holders": 1200,
      "volatility": 3.5,
      "ds_price_change": { "5m": 5.2, "15m": 8.1 },
      "risk_level": "low",
      "pvp_risk": "none"
    }
  ],
  "total_screened": 50,
  "filtered_examples": []
}
```

### deploy_position

Deploys new position on-chain.

```json
{
  "success": true,
  "position": "new_position_address...",
  "pool": "pool_address...",
  "pool_name": "ROCKET-SOL",
  "strategy": "bid_ask",
  "bins_below": 69,
  "amount_y": 0.5,
  "bin_step": 100,
  "txs": ["tx_hash1", "tx_hash2"]
}
```

### close_position

Closes position and returns SOL.

```json
{
  "success": true,
  "position": "position_address...",
  "pool": "pool_address...",
  "pool_name": "ROCKET-SOL",
  "pnl_usd": 2.15,
  "pnl_pct": 4.2,
  "initial_sol": 0.5,
  "withdrawn_sol": 0.52,
  "fees_sol": 0.02,
  "base_mint": "token_mint...",
  "txs": ["tx_hash"]
}
```

### update_config

Updates configuration and hot-reloads.

```json
{
  "success": true,
  "applied": {
    "managementIntervalMin": 5
  },
  "reason": "High volatility pool"
}
```