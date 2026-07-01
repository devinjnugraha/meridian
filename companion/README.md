# Meridian Companion

Self-contained sidecar for the Meridian DLMM agent. Runs **two features** independently of main, sending to the same Telegram chat:

1. **Wallet auditor + morning briefing** — daily wallet-value snapshot (SQLite) + a wallet-value briefing (with 7d/30d deltas), separate from main's activity briefing.
2. **Dust cleanup** — periodically sweeps dust tokens → SOL and closes empty ATAs to reclaim rent.

## Isolation guarantees
- Own `package.json` / `node_modules` / `data` / `logs`. **Never imports main's source.**
- Reads only the shared `../.env` (+ read-only `../user-config.json` for `gasReserve`).
- Never reads `state.json` (dust protection set is derived on-chain).
- Telegram is **send-only** — main keeps sole ownership of `getUpdates` polling.
- Root repo is untouched, so upstream `main` pulls are conflict-free.

## Required env (from shared `../.env`)
`WALLET_PRIVATE_KEY`, `RPC_URL`, `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional: `DRY_RUN`, `COMPANION_AUDIT_CRON`, `COMPANION_BRIEFING_CRON`, `COMPANION_DUST_CRON`, `COMPANION_DUST_THRESHOLD_USD`, `COMPANION_DB_PATH`.

## Install
```bash
cd companion && npm install
```

## Test
```bash
npm test            # node:test suites: config, wallet-snapshot, briefing
```

## Smoke (runs a job once, exits)
```bash
npm run smoke:audit        # writes today's snapshot
npm run smoke:briefing     # renders + sends the briefing
npm run smoke:dust         # DRY_RUN dust report (no transactions)
```

## Run in production (PM2 — launches main + companion together)
```bash
pm2 start companion/ecosystem.config.cjs
pm2 logs meridian-companion
pm2 stop meridian-companion   # stop just the companion; main keeps running
```

## Schedules (UTC, configurable via env)
| Job | Default | Note |
|-----|---------|------|
| Audit snapshot | `57 1 * * *` (01:57) | just before briefing |
| Wallet briefing | `3 2 * * *` (02:03) | offset from main's 01:00 briefing |
| Dust cleanup | `0 */12 * * *` | every 12h |

## Keeping up with upstream
This directory lives on the `companion` branch (off `main`). To sync:
```bash
git fetch upstream && git merge upstream/main   # companion/* is additive → no conflicts
```
