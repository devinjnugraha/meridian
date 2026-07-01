# Companion Sidecar — Design Spec

**Date:** 2026-07-01
**Branch:** dedicated `companion` branch (off `main`), serving as production runtime
**Status:** Design — awaiting review

## 1. Goal

Port two features from `experimental-custom` onto the upstream-maintained `main` codebase so they **coexist independently** and survive every upstream `main` pull **with zero merge conflicts** and **zero runtime interference** with main:

1. **Wallet auditor + morning briefing** — take a daily wallet-value snapshot, store it in SQLite, and post a *separate* morning briefing (different content, different schedule) to the same Telegram chat.
2. **Dust cleanup scheduler** — periodically sweep dust tokens → SOL and close empty ATAs to reclaim rent; post a summary to the same chat.

All secrets (`WALLET_PRIVATE_KEY`, `TELEGRAM_CHAT_ID`, etc.) come from the **shared `.env`** — single source of truth.

## 2. Context & constraints (from codebase analysis)

- `main` and `experimental-custom` have diverged heavily (+232 / +77 commits since common ancestor `d969d9f`). They are effectively different codebases. `main` is the clean, upstream-maintained line; `origin/main` already mirrors upstream (e.g. PRs from `yunus-0x`).
- **None of the target infrastructure exists on `main`:** no `better-sqlite3`, no `db.js`/`db/`, no `performance-auditor.js`, no `tools/dust-cleanup.js`. All are `experimental-custom`-only and will be ported as **new files**.
- On `experimental-custom` both features are wired *inside* `index.js`'s cron setup (`_cronTasks` array, `index.js:728-817` on `main`). `index.js` is `main`'s highest-churn file. **Integrating into main's process = recurring merge conflicts** — explicitly rejected.
- **Telegram `getUpdates` is single-consumer.** Two processes cannot both poll the same bot token. `main` already polls (for `/positions`, `/close`, `/briefing`). The companion must be **send-only**.
- `cleanDustTokens()` only *reads* tracked positions to build a protection set; it performs on-chain swaps + ATA closes (wallet-wide) and **never modifies LP positions or writes `state.json`**.
- Env keys confirmed present in `.env.example`: `WALLET_PRIVATE_KEY`, `RPC_URL`, `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DRY_RUN`.
- Root `package.json` has `"postinstall": "node scripts/patch-anchor.js"` — the DLMM SDK needs this patch; the companion must apply the same patch since it imports `@meteora-ag/dlmm`.
- `user-config.json` currently has `gasReserve: 0.2` and `dustCleanupIntervalHours: 1000` (effectively off); no `dustThresholdUsd` key (code defaults to `0.10`).

## 3. Architecture: self-contained sidecar in same repo

A new top-level directory `companion/` with its **own `package.json`, own `node_modules`, own `data/`**. It **never imports from main's source** and **never edits any file upstream maintains** (`index.js`, `config.js`, `tools/*`, `agent.js`, root `package.json`). It reads only:

- `../.env` — secrets (via dotenv with explicit path).
- `../user-config.json` — **read-only, best-effort** for `gasReserve` and an optional `dustThresholdUsd`. Companion has its own defaults if the file/keys are absent, so this is soft coupling, not a hard dependency.
- **Never reads `../state.json`.** Dust protection set is derived on-chain (see §6).

Because `companion/*` is a new path upstream does not possess, upstream can rewrite any main file entirely without affecting the companion, and `git pull`/`merge` of upstream `main` is conflict-free.

### File layout (all net-new)

```
companion/
  package.json              # own deps (see §4); NO openai/openrouter (deterministic, no LLM)
  config.js                 # companion defaults + reads ../.env + optional user-config.json
  db.js                     # better-sqlite3 init (WAL) + snapshot repo factory
  wallet-snapshot.js        # SQLite schema + repo — ported from db/wallet-snapshot.js
  lib/
    balance.js              # SOL balance (RPC) + token balances/USD (Helius) + SOL price
    positions.js            # DLMM SDK on-chain position fetch + total value
                            #   (also the dust-cleanup protection set → no state.json dep)
    telegram.js             # sendHTML()/sendMessage() — SEND-ONLY, same chat id, never polls
    swap.js                 # minimal Jupiter swap (dust → SOL)
  features/
    auditor.js              # runAudit(): balance + positions → SQLite snapshot row
    briefing.js             # generateWalletBriefing(): SQLite history → HTML (7d/30d deltas)
    dust.js                 # cleanDust(): on-chain protection set → swap dust + close ATAs
  scripts/patch-anchor.js   # copy of root patch; wired as postinstall (DLMM SDK needs it)
  ecosystem.config.js       # PM2 config launching BOTH main + companion (see §7)
  index.js                  # entry: init db → register node-cron jobs → run
  README.md                 # how to run, schedules, what it touches/avoids
  .gitignore                # ignores companion/node_modules + companion/data/*.db*
```

The **repo root is not modified at all** — not even `ecosystem.config.js`, which lives under `companion/`.

## 4. Dependencies (`companion/package.json`)

- `better-sqlite3` — SQLite snapshots
- `@solana/web3.js`, `@solana/spl-token`, `bs58` — wallet, ATA close, keypair
- `@meteora-ag/dlmm` — on-chain position fetch
- `node-cron` — schedules
- `dotenv` — load `../.env`

Notably **no `openai`/`openrouter`** — both features are deterministic; no LLM is needed. `postinstall` runs `scripts/patch-anchor.js` (copy from root) so the DLMM SDK installs cleanly in the companion's own `node_modules`.

## 5. Feature 1 — Wallet auditor + morning briefing

### Snapshot shape (verbatim from `performance-auditor.js`)
```
{ date, sol, sol_price, wallet_usd, positions_usd, positions_sol,
  position_count, grand_total_usd, grand_total_sol }
```
`date` = UTC `YYYY-MM-DD`; row is unique per date (upsert).

### `features/auditor.js` → `runAudit()`
- `lib/balance.js` → SOL balance, token balances + USD (Helius), SOL/USD price.
- `lib/positions.js` → on-chain DLMM positions for the wallet + `total_value_usd`.
- Build snapshot, `walletRepo.insert(snapshot)`, log result.
- Pure read of the chain + SQLite write. No coupling to main's runtime.

### `features/briefing.js` → `generateWalletBriefing()`
- Reads snapshot history from SQLite (`latest`, 7-day, 30-day via `getRange`).
- Renders an HTML message focused on **wallet value**: today's totals (SOL + USD), 7d / 30d delta (USD and %), position count. This is deliberately **different content** from main's `briefing.js` (which shows position/PnL activity and lessons).
- Posts via `lib/telegram.js` to `TELEGRAM_CHAT_ID`.

### SQLite schema (`wallet-snapshot.js`, ported from `db/wallet-snapshot.js`)
Table `wallet_snapshots` with columns: `id, date (UNIQUE), sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol, created_at` + index on `date`. Repo methods: `insert` (upsert), `get(date)`, `getLatest()`, `getRange(from,to)`, `delete(date)`. DB file: `companion/data/companion.db` (own file; no clash with main).

## 6. Feature 2 — Dust cleanup scheduler

### `features/dust.js` → `cleanDust()`
Behavior mirrors `tools/dust-cleanup.js`, re-implemented against companion's own libs:
1. `lib/balance.js` → token balances + USD (Helius).
2. RPC → all token accounts (Token + Token-2022 programs) with ATA addresses.
3. **Protection set from `lib/positions.js`** (on-chain positions' base mints) — **not** `state.json`. Also protect SOL/USDC/USDT.
4. Categorize: `swapCandidates` (balance > 0 and USD < threshold) and `closeCandidates` (balance == 0).
5. Swap phase: `lib/swap.js` (Jupiter) dust → SOL, sequential with delay; after each swap, re-check and queue empties for close.
6. Close phase: batched `createCloseAccountInstruction`, fallback to single closes on batch failure.
7. Summary: counts swapped/closed, SOL reclaimed (`accounts_closed * RENT_PER_ATA`).

### Safety
- Honors `DRY_RUN` → report-only, no transactions (the smoke-test path).
- `gasReserve` guard (best-effort read from `../user-config.json`, default `0.2`): skip if SOL below reserve.
- Dust threshold: companion config / env, default `$0.10`.
- Wallet-wide writes only (swap + rent reclaim). **Never closes or modifies LP positions.**
- Posts a summary to the same chat id.

## 7. Process model — PM2 (both processes)

`companion/ecosystem.config.js` defines two apps and is the single PM2 entry point:

```js
module.exports = {
  apps: [
    { name: "meridian-main",      cwd: __dirname + "/..", script: "index.js",        autorestart: true },
    { name: "meridian-companion", cwd: __dirname,         script: "index.js",        autorestart: true },
  ],
};
```

Run with `pm2 start companion/ecosystem.config.js`. Main keeps its existing launch path (`node index.js`); the companion is the second app. Auto-restart + separate logs via PM2. **No root file is added** — the ecosystem file lives under `companion/`, preserving the conflict-free guarantee.

## 8. Schedules (companion's own `node-cron`, zero overlap with main)

| Job           | Default cron        | Note                                          |
|---------------|---------------------|-----------------------------------------------|
| Audit snapshot | `57 1 * * *` (01:57 UTC) | runs just before the briefing                |
| Wallet briefing | `3 2 * * *` (02:03 UTC)  | offset from main's 01:00 UTC briefing        |
| Dust cleanup   | `0 */12 * * *` (every 12h) | configurable; main currently has this off (1000h) |

All three configurable via companion config/env. None collide with main's cron timings or content.

## 9. Telegram discipline

Companion is **send-only**: it posts HTML/text to `TELEGRAM_CHAT_ID` using `TELEGRAM_BOT_TOKEN` and **never calls `getUpdates`**. Main remains the sole poller. This is the only safe way to share one bot token across two processes.

## 10. Branch & upstream-sync strategy

- New dedicated long-lived branch `companion` off `main`. This is the **production runtime branch**.
- `companion/*` is additive and the root is untouched, so merging/rebasing upstream `main` is conflict-free.
- `origin/main` stays a clean mirror of upstream (not polluted with companion commits).
- **Upstream sync workflow** (resolve open item §12): either (a) add an `upstream` remote pointing at the original repo and `git fetch upstream && git merge upstream/main` on the `companion` branch; or (b) use GitHub "Sync fork" to refresh `origin/main`, then `git pull origin main` (or `git merge origin/main`) on `companion`. Recommend (a) for reliability.

## 11. Testing / verification

- **DRY_RUN smoke test:** `DRY_RUN=true node companion/index.js` (or trigger jobs once) — confirm SQLite snapshot row written, briefing HTML rendered/logged, dust reports candidates without transacting, no Telegram getUpdates calls.
- **SQLite repo:** insert/get/getRange round-trip on a temp DB.
- **Briefing:** render from seeded snapshots, verify 7d/30d deltas.
- **Telegram send-only assertion:** confirm companion source has zero `getUpdates`/`startPolling` references.
- Manual: run under PM2 with `DRY_RUN=true`, observe both processes and the two Telegram messages landing in the same chat.

## 12. Open items to confirm before/early in implementation

1. **Original upstream repo URL** (for the `upstream` remote). PR refs suggest `yunus-0x/meridian`; confirm exact URL. (Does not block architecture — only the sync workflow.)
2. **Briefing timezone / exact time.** Default is 02:03 UTC; adjust to your local "morning" if desired.
3. **Dust interval default** (proposed 12h) and **dust threshold** (proposed $0.10) — confirm or set via companion config.

## 13. Out of scope (NOT ported from `experimental-custom`)

The lessons system / threshold evolution, the PnL poller, `solMode`, scoring/signal-weight changes, the main briefing changes, and all other `experimental-custom` customizations. Only the two requested features are ported, and only as the self-contained companion described above.
