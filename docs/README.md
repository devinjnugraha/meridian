# Meridian Documentation

This repository contains comprehensive documentation for the Meridian Solana DLMM LP Agent.

## Documentation Files

| Document | Description |
|----------|-------------|
| `MERIDIAN-DOCUMENTATION.md` | Main overview - what it does, architecture, core modules, agents, data stores, tools, configuration, CLI, HiveMind, security, setup |
| `DEPLOYMENT-STRATEGY.md` | Technical deep-dive on bin range calculation, deployment amount, strategies, safety checks, exit triggers, cooldown system, auto-swap, dynamic schedule |
| `SELF-LEARNING-SYSTEM.md` | Agent learning approach - performance analysis, adaptive thresholds, Darwinian signal weighting, lesson injection, self-tuning, HiveMind integration |
| `TOOL-CATALOG.md` | Complete list of all agent tools - read-only, write, meta tools, execution flow, examples |
| `EXIT-RULES.md` | Comprehensive exit rule documentation - priority order, deterministic rules, instruction-based exits, LLM evaluation |
| `AGENTS-DETAILED.md` | Agent details - Hunter Alpha (SCREENER) and Healer Alpha (MANAGER) roles, toolsets, decision processes, key behaviors |
| `HIVE-MIND-REFERENCE.md` | HiveMind technical reference - enablement, local state, main flows, endpoints, safety |
| `SETUP-GUIDE.md` | Step-by-step setup guide - prerequisites, installation, configuration, first run, common issues, maintenance |

## Quick Start

For a quick overview of what Meridian does and how it works, start with:

1. **MERIDIAN-DOCUMENTATION.md** - Main overview
2. **SETUP-GUIDE.md** - Setup instructions
3. **DEPLOYMENT-STRATEGY.md** - Technical details

## Agent Overview

Meridian runs two specialized agents:

**Hunter Alpha (SCREENER)**
- Finds high-quality pool opportunities
- Runs every 30 minutes (configurable)
- Uses Meteora Pool Discovery API, OKX, DexScreener

**Healer Alpha (MANAGER)**  
- Manages and closes positions
- Runs every 10 minutes (configurable)
- Applies exit rules and auto-actions

## Learning System

Meridian improves over time through:

1. **Performance-based lessons** - Extracts insights from wins/losses
2. **Adaptive thresholds** - Evolves screening criteria based on results
3. **Darwinian signal weighting** - Learns which signals predict success

## HiveMind (Optional)

The optional HiveMind feature enables collective intelligence:
- Shares lessons with other Meridian agents
- Receives pool consensus and strategy rankings
- Anonymous sharing (no wallets or private data)

## Key Features

- **Autonomous operation** - Full ReAct agent loop with tool calling
- **Dual-agent architecture** - Hunter (screening) and Healer (management)
- **Self-learning** - Performance-based lessons and adaptive thresholds
- **Telegram integration** - Full chat interface and notifications
- **Performance tracking** - Detailed auditing and reporting
- **Safety mechanisms** - Dry-run mode, cooldowns, safety checks

## Configuration

All configuration is in `user-config.json` with sensible defaults. Key areas:

- Risk limits (max positions, max deploy amount)
- Screening thresholds (fee/TVL, volume, organic, etc.)
- Exit rules (trailing TP, stop loss, OOR wait)
- Scheduling (management and screening intervals)
- LLM settings (model, temperature, max tokens)
- HiveMind (optional collective intelligence)

## Safety

- Dry-run mode for testing
- Safety checks before all write operations
- Cooldown system to prevent over-trading
- Token blacklist and dev blocklist
- Telegram security (no auto-registration)