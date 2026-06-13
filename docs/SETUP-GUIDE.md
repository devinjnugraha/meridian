# Setup Guide

## Prerequisites

- Node.js 18+ installed
- OpenRouter API key
- Solana wallet with base58 private key
- Optional: Helius API key, Telegram bot token

## Installation

### 1. Clone the Repository

```bash
git clone <repo-url>
cd dlmm-agent
```

### 2. Install Dependencies

```bash
npm install
```

This installs:
- `@meteora-ag/dlmm` - Meteora DLMM SDK
- `@solana/web3.js` - Solana web3 library
- `@solana/spl-token` - SPL Token library
- `openai` - OpenRouter API client
- `node-cron` - Cron job scheduling
- `better-sqlite3` - SQLite database

### 3. Configure Environment

Create `.env` file with required variables:

```bash
cp .env.example .env
# Edit .env with your values
```

Required variables:
```
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=your_base58_private_key
```

Optional variables:
```
RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=your_helius_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
TELEGRAM_ALLOWED_USER_IDS=your_telegram_user_id
LPAGENT_API_KEY=your_lpagent_api_key
DRY_RUN=true
LLM_MODEL=openrouter/healer-alpha
LOG_LEVEL=info
```

**RPC URL Options**:
- Default: `https://pump.helius-rpc.com` (no key needed)
- Helius: `https://rpc.helius.xyz/?api-key=your_key`
- QuickNode, Triton, Alchemy, etc.

**Helius API Key**:
- Required for wallet balance lookups
- Saves 100 Helius credits per call
- Free tier available

**Telegram Setup**:
1. Create bot via @BotFather
2. Get bot token
3. Get your chat ID (chat with bot, then `https://api.telegram.org/bot{token}/getUpdates`)
4. Set `TELEGRAM_CHAT_ID` and `TELEGRAM_ALLOWED_USER_IDS`

### 4. Configure Agent Settings

Copy and edit the example configuration:

```bash
cp user-config.example.json user-config.json
# Edit user-config.json with your preferences
```

Key settings to consider:

**Risk Management**:
```json
{
  "maxPositions": 3,
  "maxDeployAmount": 50,
  "deployAmountSol": 0.5,
  "minSolToOpen": 0.55,
  "gasReserve": 0.2,
  "positionSizePct": 0.35
}
```

**Screening Thresholds**:
```json
{
  "minFeeActiveTvlRatio": 0.05,
  "minTvl": 10000,
  "maxTvl": 150000,
  "minVolume": 500,
  "minOrganic": 60,
  "minHolders": 500,
  "minMcap": 150000,
  "maxMcap": 10000000
}
```

**Exit Rules**:
```json
{
  "trailingTakeProfit": true,
  "trailingTriggerPct": 3,
  "trailingDropPct": 1.5,
  "stopLossPct": -50,
  "takeProfitPct": 5
}
```

**Scheduling**:
```json
{
  "managementIntervalMin": 10,
  "screeningIntervalMin": 30
}
```

### 5. Optional: HiveMind Setup

To enable collective intelligence sharing:

1. Get registration token from private Telegram discussion
2. Register your agent:
   ```bash
   node -e "import('./hivemind.js').then(m => m.register('https://api.agentmeridian.xyz', 'YOUR_TOKEN'))"
   ```
3. Save the API key printed in terminal (will not be shown again)

This automatically configures:
- `hiveMindUrl`: `https://api.agentmeridian.xyz`
- `hiveMindApiKey`: Your API key
- `agentId`: Generated unique ID

### 6. Run Setup

Run the setup script (if provided):
```bash
npm run setup
```

### 7. Test in Dry-Run Mode

```bash
npm run dev
```

This starts the agent in dry-run mode:
- No on-chain transactions
- All API calls still execute
- Good for testing configuration

### 8. Start Live Trading

When ready for live trading:
```bash
npm start
```

Set `DRY_RUN=false` in .env (or remove the line)

## First Run

### What Happens on Startup

1. Load configuration from `.env` and `user-config.json`
2. Initialize wallet and RPC connection
3. Fetch wallet balance
4. Fetch open positions
5. Fetch top pool candidates
6. Start cron jobs:
   - Management cycle every 10 minutes
   - Screening cycle every 30 minutes
   - Health check every 60 minutes
   - Dust cleanup every 6 hours

### Expected Output

```
[timestamp] [STARTUP] DLMM LP Agent starting...
[timestamp] [STARTUP] Mode: DRY RUN
[timestamp] [STARTUP] Default Model: openrouter/healer-alpha
[timestamp] [STARTUP] General Model: openrouter/healer-alpha
[timestamp] [STARTUP] Management Model: openrouter/healer-alpha
[timestamp] [STARTUP] Screening Model: openrouter/hunter-alpha
```

### Initial REPL Prompt

After startup, you'll see:
```
[manage: 9m 45s | screen: 29m 15s]
>
```

This shows countdown to next cycles.

## Common Issues

### Wallet Not Configured

**Error**: `WALLET_PRIVATE_KEY not set`

**Solution**:
- Check `.env` has `WALLET_PRIVATE_KEY=your_key`
- Key should be base58 encoded (52-53 characters)
- Verify key format: starts with `5`, contains numbers and letters

### RPC Connection Failed

**Error**: `Failed to fetch`, `ECONNREFUSED`, or timeout

**Solution**:
- Check RPC_URL is accessible
- Verify API key if required
- Try different RPC endpoint
- Check network connectivity

### OpenRouter API Error

**Error**: `Invalid API key`, `401 Unauthorized`

**Solution**:
- Verify OPENROUTER_API_KEY in `.env`
- Check key format: `sk-or-...`
- Ensure key has credits/balance

### Telegram Bot Not Working

**Error**: Notifications not sent, commands not working

**Solution**:
- Verify TELEGRAM_BOT_TOKEN is set
- Set TELEGRAM_CHAT_ID to your chat ID
- Set TELEGRAM_ALLOWED_USER_IDS to your user ID
- Test: `/status` command in Telegram

### No Positions Found

**Normal if**: Just started, no deploys yet

**Check**:
- Wallet has SOL balance
- Previous positions were closed
- Agent just started (no deploys yet)

### Candidates Not Found

**Normal if**: No pools meet screening criteria

**Check**:
- Screening thresholds in `user-config.json`
- Try lowering `minFeeActiveTvlRatio`, `minTvl`, `minVolume`
- Check time of day (some pools only active at certain times)

## Post-Setup

### Monitor the Agent

**Console Output**:
- Management cycle starts/ends
- Screening cycle starts/ends
- Deploy/close/claim/swap actions
- Errors and warnings

**Telegram Notifications**:
- Cycle reports
- Deploy/close alerts
- Out-of-range alerts
- Error notifications

**State Files**:
- `state.json` - Position metadata
- `lessons.json` - Agent learning
- `pool-memory.json` - Deploy history
- `logs/agent-YYYY-MM-DD.log` - Daily logs

### Adjust Configuration

Based on agent behavior:

**Too many deploys**:
- Increase `maxPositions`
- Raise screening thresholds
- Lower `positionSizePct`

**Too few deploys**:
- Lower screening thresholds
- Increase `deployAmountSol`
- Enable more Discord signals

**Positions closing too soon**:
- Increase `outOfRangeWaitMinutes`
- Increase `trailingTriggerPct`
- Increase `trailingDropPct`
- Disable `dynamicILStop` if not needed

**Low PnL**:
- Raise `minFeeActiveTvlRatio`
- Raise `minOrganic`
- Raise `minHolders`
- Enable `dynamicILStop`

### Enable HiveMind

1. Get registration token
2. Run registration command
3. Save API key
4. Agent auto-syncs every 15 minutes

### Set Up Monitoring

**Log files**:
- `logs/agent-YYYY-MM-DD.log` - Agent execution logs
- `logs/actions-YYYY-MM-DD.jsonl` - Action audit trail

**Performance**:
- Check `lessons.json` for performance data
- Review closed positions
- Analyze lessons learned

**Wallet**:
- Monitor SOL balance
- Check for dust tokens
- Review position count

## Safety Checklist

- [ ] Test in dry-run mode first
- [ ] Start with small deploy amounts
- [ ] Monitor first few cycles closely
- [ ] Set appropriate `maxPositions`
- [ ] Set `stopLossPct` to acceptable loss
- [ ] Configure Telegram notifications
- [ ] Set up log monitoring
- [ ] Review configuration before live trading
- [ ] Test Telegram commands work
- [ ] Verify RPC endpoint reliability

## Maintenance

### Weekly
- Review `lessons.json` for new patterns
- Check `pool-memory.json` for cooldowns
- Review performance in Telegram reports

### Monthly
- Update agent code (git pull)
- Review and adjust thresholds
- Check API credits/balances
- Review HiveMind insights

### Quarterly
- Full configuration review
- Update dependencies
- Backup state files
- Review and clean lessons