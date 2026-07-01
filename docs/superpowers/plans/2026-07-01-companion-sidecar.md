# Companion Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained `companion/` sidecar to the upstream-maintained `main` codebase that (1) takes a daily wallet-value snapshot into SQLite and posts a separate morning briefing, and (2) runs a dust-cleanup scheduler — both send-only to the same Telegram chat, with zero coupling to main's source and zero merge-conflict risk on upstream pulls.

**Architecture:** A new `companion/` directory with its own `package.json`/`node_modules`/`data`. It imports nothing from main; it reads only the shared `../.env` (and read-only `../user-config.json` for `gasReserve`). Dust protection set is derived on-chain (no `state.json`). It runs as a second PM2 process via `companion/ecosystem.config.js`. Lives on a dedicated `companion` branch off `main`; root is untouched so upstream rebases are conflict-free.

**Tech Stack:** Node.js (ESM, `engines >=18`), `better-sqlite3`, `@solana/web3.js`, `@solana/spl-token`, `bs58`, `node-cron`, `dotenv`. Tests via Node's built-in `node:test` + `node:assert/strict` (no extra deps). No LLM/OpenAI dependency.

**Spec:** `docs/superpowers/specs/2026-07-01-companion-sidecar-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `companion/package.json` | Own deps, scripts (`start`, `test`, `smoke`), `postinstall` patch |
| `companion/.gitignore` | Ignore `node_modules/`, `data/*.db*`, `logs/` |
| `companion/logger.js` | `log(type, msg)` → console + daily file under `companion/logs/` |
| `companion/config.js` | `loadConfig(env, opts)` pure fn + `config` singleton; inlines token mints, schedules, dust defaults; best-effort `gasReserve` from `../user-config.json` |
| `companion/db.js` | `better-sqlite3` singleton (WAL) + `getWalletRepo()` |
| `companion/wallet-snapshot.js` | `migrate(db)` + `createWalletSnapshotRepo(db)` (ported, testable in isolation) |
| `companion/lib/balance.js` | `getWalletValue()` — Helius balances (SOL, tokens, USD, SOL price) |
| `companion/lib/positions.js` | `getOnChainPositions()` — Meteora portfolio + PnL APIs (count, base mints, total USD) |
| `companion/lib/telegram.js` | `isEnabled()` / `sendMessage()` / `sendHTML()` — send-only, read-only chat id |
| `companion/lib/swap.js` | `swapToken()` — Jupiter Swap V2 (port), honors `DRY_RUN` |
| `companion/features/auditor.js` | `runAudit()` — balance + positions → SQLite snapshot row |
| `companion/features/briefing.js` | `generateWalletBriefing(snapshots, opts)` — pure render (TDD) |
| `companion/features/dust.js` | `cleanDust()` — swap dust + close ATAs, on-chain protection, telegram summary |
| `companion/scripts/patch-anchor.js` | Copy of root patch (DLMM SDK Node-24 ESM fix) |
| `companion/ecosystem.config.js` | PM2 config launching BOTH main + companion |
| `companion/index.js` | Entry: dotenv, env validation, db init, `--run <job>` smoke harness OR cron registration |
| `companion/README.md` | Run/schedule/isolation docs |
| `companion/test/*.test.js` | `node:test` suites for snapshot repo, briefing render, config |

**Test strategy:** TDD the pure units (wallet-snapshot repo, briefing render, config). Network/SDK wrappers (balance, positions, telegram, swap) and orchestrators (auditor, dust, index) are verified via a `DRY_RUN` smoke harness (`node companion/index.js --run <job>`), since they are thin layers over external APIs that cannot be meaningfully unit-tested without mocking entire SDKs.

---

## Task 0: Branch, commit spec, scaffold companion

**Files:**
- Create: `companion/package.json`, `companion/.gitignore`, `companion/scripts/patch-anchor.js`
- Branch: `companion` (off `main`)

- [ ] **Step 1: Create the dedicated `companion` branch off `main`**

The spec file (`docs/superpowers/specs/2026-07-01-companion-sidecar-design.md`) is currently an untracked file on `experimental-custom`. Switching to a new branch off `main` carries untracked files along, so the spec comes with us.

```bash
git checkout main
git checkout -b companion
git status   # confirm on `companion`, spec file present (untracked)
```

- [ ] **Step 2: Commit the spec onto the `companion` branch**

```bash
git add docs/superpowers/specs/2026-07-01-companion-sidecar-design.md
git commit -m "docs: companion sidecar design spec

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 3: Create `companion/package.json`**

```json
{
  "name": "meridian-companion",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Self-contained sidecar: wallet auditor snapshots + morning briefing + dust cleanup",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/",
    "smoke:audit": "node index.js --run audit",
    "smoke:briefing": "node index.js --run briefing",
    "smoke:dust": "DRY_RUN=true node index.js --run dust",
    "postinstall": "node scripts/patch-anchor.js"
  },
  "dependencies": {
    "@meteora-ag/dlmm": "1.9.4",
    "@solana/spl-token": "^0.3.11",
    "@solana/web3.js": "^1.95.0",
    "better-sqlite3": "^12.10.0",
    "bn.js": "^5.2.1",
    "bs58": "^5.0.0",
    "dotenv": "^17.3.1",
    "node-cron": "^3.0.3"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 4: Create `companion/.gitignore`**

```
node_modules/
data/*.db
data/*.db-*
logs/
.env
```

- [ ] **Step 5: Copy the patch-anchor script into `companion/scripts/`**

Copy `scripts/patch-anchor.js` verbatim to `companion/scripts/patch-anchor.js`. It computes `root = path.join(__dirname, "..")`, so placed under `companion/scripts/` it patches `companion/node_modules/...` — exactly what we want. Use:

```bash
mkdir -p companion/scripts
cp scripts/patch-anchor.js companion/scripts/patch-anchor.js
```

- [ ] **Step 6: Install dependencies (triggers the patch via postinstall)**

```bash
cd companion && npm install
```

Expected: install succeeds; console prints `Patched: @coral-xyz/anchor/package.json exports` and `Patched: @meteora-ag/dlmm/dist/index.mjs ...` (or `Skip: ... already patched`).

- [ ] **Step 7: Commit scaffold**

```bash
cd ..
git add companion/package.json companion/.gitignore companion/scripts/patch-anchor.js
git commit -m "feat(companion): scaffold package + gitignore + anchor patch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 1: Logger

**Files:**
- Create: `companion/logger.js`

No test — trivial passthrough; exercised by every later task.

- [ ] **Step 1: Create `companion/logger.js`**

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function log(type, message) {
  const line = `[${new Date().toISOString()}] [${type}] ${message}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `companion-${dayStamp()}.log`), line + "\n");
  } catch {
    /* logging must never throw */
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add companion/logger.js
git commit -m "feat(companion): minimal logger

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Config (TDD)

**Files:**
- Create: `companion/config.js`
- Test: `companion/test/config.test.js`

- [ ] **Step 1: Write the failing test**

`companion/test/config.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("loadConfig applies schedule + dust defaults", () => {
  const cfg = loadConfig({}, { userConfig: null });
  assert.equal(cfg.schedule.auditCron, "57 1 * * *");
  assert.equal(cfg.schedule.briefingCron, "3 2 * * *");
  assert.equal(cfg.schedule.dustCron, "0 */12 * * *");
  assert.equal(cfg.dust.thresholdUsd, 0.1);
});

test("loadConfig inlines canonical token mints", () => {
  const cfg = loadConfig({}, { userConfig: null });
  assert.equal(cfg.tokens.SOL, "So11111111111111111111111111111111111111112");
  assert.equal(cfg.tokens.USDC, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(cfg.tokens.USDT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
});

test("loadConfig reads gasReserve from user-config.json when present", () => {
  const cfg = loadConfig({}, { userConfig: { management: { gasReserve: 0.5 } } });
  assert.equal(cfg.gasReserve, 0.5);
});

test("loadConfig falls back to default gasReserve when absent", () => {
  const cfg = loadConfig({}, { userConfig: { management: {} } });
  assert.equal(cfg.gasReserve, 0.2);
});

test("loadConfig reads env overrides for cron + threshold", () => {
  const cfg = loadConfig(
    { COMPANION_AUDIT_CRON: "0 5 * * *", COMPANION_DUST_THRESHOLD_USD: "0.25" },
    { userConfig: null },
  );
  assert.equal(cfg.schedule.auditCron, "0 5 * * *");
  assert.equal(cfg.dust.thresholdUsd, 0.25);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd companion && node --test test/config.test.js
```

Expected: FAIL — `Cannot find module '../config.js'`.

- [ ] **Step 3: Implement `companion/config.js`**

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_USER_CONFIG_PATH = path.join(__dirname, "..", "user-config.json");

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

function readUserConfig(p) {
  try {
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* best-effort; fall through to defaults */
  }
  return {};
}

/**
 * Pure config builder. `env` defaults to process.env at module load.
 * `opts.userConfig` injects a parsed user-config.json (tests);
 * `opts.userConfigPath` overrides the default ../user-config.json path.
 */
export function loadConfig(env = process.env, opts = {}) {
  // opts.userConfig: explicit value used as-is (null = "no user config", hermetic for tests);
  // undefined = fall back to reading ../user-config.json from disk.
  const userConfig = opts.userConfig !== undefined ? opts.userConfig : readUserConfig(opts.userConfigPath ?? DEFAULT_USER_CONFIG_PATH);
  const mgmt = userConfig?.management ?? {};

  const thresholdFromEnv = parseFloat(env.COMPANION_DUST_THRESHOLD_USD);
  const thresholdFromCfg = mgmt.dustThresholdUsd;

  return {
    tokens: TOKENS,
    gasReserve: typeof mgmt.gasReserve === "number" ? mgmt.gasReserve : 0.2,
    dust: {
      thresholdUsd: Number.isFinite(thresholdFromEnv)
        ? thresholdFromEnv
        : Number.isFinite(thresholdFromCfg)
          ? thresholdFromCfg
          : 0.1,
      swapDelayMs: 2000,
      batchSize: 20,
    },
    swap: {
      slippageBps: 300,
      apiKey: "448b0561-15d0-4e51-b632-996c5d7651f7",
    },
    schedule: {
      auditCron: env.COMPANION_AUDIT_CRON || "57 1 * * *",
      briefingCron: env.COMPANION_BRIEFING_CRON || "3 2 * * *",
      dustCron: env.COMPANION_DUST_CRON || "0 */12 * * *",
    },
    dbPath: env.COMPANION_DB_PATH || path.join(__dirname, "data", "companion.db"),
    dryRun: env.DRY_RUN === "true",
  };
}

export const config = loadConfig();
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/config.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd ..
git add companion/config.js companion/test/config.test.js
git commit -m "feat(companion): config loader with defaults + user-config gasReserve

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: SQLite wallet-snapshot repo (TDD)

**Files:**
- Create: `companion/wallet-snapshot.js`, `companion/db.js`
- Test: `companion/test/wallet-snapshot.test.js`

- [ ] **Step 1: Write the failing test**

`companion/test/wallet-snapshot.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, createWalletSnapshotRepo } from "../wallet-snapshot.js";

function makeRepo() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, repo: createWalletSnapshotRepo(db) };
}

const snapshot = (date, sol, total) => ({
  date, sol, sol_price: 150, wallet_usd: sol * 150,
  positions_usd: total - sol * 150, positions_sol: 0,
  position_count: 1, grand_total_usd: total, grand_total_sol: sol,
});

test("insert then get returns the snapshot", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  assert.equal(repo.get("2026-07-01").sol, 10);
});

test("insert upserts on same date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.insert(snapshot("2026-07-01", 12, 1800));
  const got = repo.get("2026-07-01");
  assert.equal(got.sol, 12);
  assert.equal(repo.getLatest().sol, 12);
});

test("getLatest returns null when empty", () => {
  const { repo } = makeRepo();
  assert.equal(repo.getLatest(), null);
});

test("getRange returns ascending by date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-03", 10, 1600));
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.insert(snapshot("2026-07-02", 10, 1600));
  const range = repo.getRange("2026-07-01", "2026-07-03");
  assert.deepEqual(range.map(r => r.date), ["2026-07-01", "2026-07-02", "2026-07-03"]);
});

test("delete removes a date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.delete("2026-07-01");
  assert.equal(repo.get("2026-07-01"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd companion && node --test test/wallet-snapshot.test.js
```

Expected: FAIL — `Cannot find module '../wallet-snapshot.js'`.

- [ ] **Step 3: Implement `companion/wallet-snapshot.js`**

Ported from `db/wallet-snapshot.js`, schema/repo only (no singleton here):

```js
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL UNIQUE,
      sol             REAL    NOT NULL,
      sol_price       REAL    NOT NULL,
      wallet_usd      REAL    NOT NULL,
      positions_usd   REAL    NOT NULL DEFAULT 0,
      positions_sol   REAL    NOT NULL DEFAULT 0,
      position_count  INTEGER NOT NULL DEFAULT 0,
      grand_total_usd REAL    NOT NULL,
      grand_total_sol REAL    NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_date ON wallet_snapshots(date);
  `);
}

export function createWalletSnapshotRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO wallet_snapshots
        (date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        sol = excluded.sol, sol_price = excluded.sol_price,
        wallet_usd = excluded.wallet_usd, positions_usd = excluded.positions_usd,
        positions_sol = excluded.positions_sol, position_count = excluded.position_count,
        grand_total_usd = excluded.grand_total_usd, grand_total_sol = excluded.grand_total_sol`),
    get: db.prepare(`SELECT * FROM wallet_snapshots WHERE date = ?`),
    latest: db.prepare(`SELECT * FROM wallet_snapshots ORDER BY date DESC LIMIT 1`),
    range: db.prepare(`SELECT * FROM wallet_snapshots WHERE date >= ? AND date <= ? ORDER BY date ASC`),
    delete_: db.prepare(`DELETE FROM wallet_snapshots WHERE date = ?`),
  };

  return {
    insert(data) {
      stmts.upsert.run(
        data.date, data.sol, data.sol_price, data.wallet_usd,
        data.positions_usd, data.positions_sol, data.position_count,
        data.grand_total_usd, data.grand_total_sol,
      );
    },
    get(date) { return stmts.get.get(date) ?? null; },
    getLatest() { return stmts.latest.get() ?? null; },
    getRange(fromDate, toDate) { return stmts.range.all(fromDate, toDate); },
    delete(date) { stmts.delete_.run(date); },
  };
}
```

- [ ] **Step 4: Implement `companion/db.js`** (singleton wrapper)

```js
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { migrate, createWalletSnapshotRepo } from "./wallet-snapshot.js";

let _db = null;
let _walletRepo = null;

export function init(dbPath) {
  if (_db) return;
  const resolved = dbPath || config.dbPath;
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(resolved);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  _walletRepo = createWalletSnapshotRepo(_db);
}

function _ensure() { if (!_db) init(); }

export function close() {
  if (_db) { _db.close(); _db = null; _walletRepo = null; }
}

export function getWalletRepo() { _ensure(); return _walletRepo; }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test test/wallet-snapshot.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd ..
git add companion/wallet-snapshot.js companion/db.js companion/test/wallet-snapshot.test.js
git commit -m "feat(companion): SQLite wallet-snapshot repo + db singleton

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Balance library (Helius)

**Files:**
- Create: `companion/lib/balance.js`

Smoke-verified (Task 11), not unit-tested (network).

- [ ] **Step 1: Create `companion/lib/balance.js`**

Ported lean from `tools/wallet.js:getWalletBalances`. No cache, no `notify3rdPartyError`, inlined token mints from `config`.

```js
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _wallet = null;
export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const EMPTY = (walletAddress, error) => ({
  wallet: walletAddress ?? null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error,
});

/**
 * Fetch wallet balances (SOL, USDC, all SPL tokens) with USD values via Helius.
 * Returns the same shape as main's getWalletBalances.
 */
export async function getWalletValue() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return EMPTY(null, "Wallet not configured");
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("balance_error", "HELIUS_API_KEY not set in .env");
    return EMPTY(walletAddress, "Helius API key missing");
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const balances = data.balances || [];

    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round((solEntry?.balance || 0) * 1e6) / 1e6,
      sol_price: Math.round((solEntry?.pricePerToken || 0) * 100) / 100,
      sol_usd: Math.round((solEntry?.usdValue || 0) * 100) / 100,
      usdc: Math.round((usdcEntry?.balance || 0) * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("balance_error", error.message);
    return EMPTY(walletAddress, error.message);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add companion/lib/balance.js
git commit -m "feat(companion): Helius wallet balance library

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Positions library (Meteora portfolio + PnL APIs)

**Files:**
- Create: `companion/lib/positions.js`

Smoke-verified (Task 11), not unit-tested (network). Lean replacement for main's entangled `getMyPositions`: no `state.js`, no `solMode`, no LPAgent, no metadata enrichment.

- [ ] **Step 1: Create `companion/lib/positions.js`**

Uses the two Meteora endpoints that `getMyPositions` itself relies on:
- portfolio discovery: `https://dlmm.datapi.meteora.ag/portfolio/open?user=<addr>`
- per-pool PnL (USD value + base mint): `https://dlmm.datapi.meteera.ag/positions/<pool>/pnl?user=<addr>&status=open&pageSize=100&page=1`

```js
import { log } from "../logger.js";
import { getWallet } from "./balance.js";

/**
 * Fetch the wallet's open DLMM positions on-chain (no state.json dependency).
 * Returns { wallet, position_count, positions:[{position,pool,base_mint,total_value_usd}],
 *           total_value_usd, error? }.
 * Used by the auditor (total value + count) and dust cleanup (base-mint protection set).
 */
export async function getOnChainPositions() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, position_count: 0, positions: [], total_value_usd: 0, error: "Wallet not configured" };
  }

  try {
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();
    const pools = portfolio.pools || [];

    // Per-pool PnL: gives positionAddress + unrealizedPnl.balances (USD) per position.
    const pnlMaps = await Promise.all(pools.map(p => fetchPnlForPool(p.poolAddress, walletAddress)));

    const positions = [];
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const byAddr = pnlMaps[i];
      for (const positionAddress of (pool.listPositions || [])) {
        const pnl = byAddr?.[positionAddress] || null;
        const valueUsd = pnl ? round4(parseFloat(pnl.unrealizedPnl?.balances || 0)) : null;
        positions.push({
          position: positionAddress,
          pool: pool.poolAddress,
          base_mint: pool.tokenXMint,
          total_value_usd: valueUsd,
        });
      }
    }

    const known = positions.filter(p => p.total_value_usd != null);
    const total = round4(known.reduce((s, p) => s + p.total_value_usd, 0));
    return { wallet: walletAddress, position_count: positions.length, positions, total_value_usd: total };
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.message}`);
    return { wallet: walletAddress, position_count: 0, positions: [], total_value_usd: 0, error: error.message };
  }
}

async function fetchPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const list = data.positions || data.data || [];
    const byAddress = {};
    for (const p of list) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("positions_error", `PnL fetch error for ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

function round4(n) { return Math.round(n * 10000) / 10000; }
```

- [ ] **Step 2: Commit**

```bash
git add companion/lib/positions.js
git commit -m "feat(companion): on-chain positions via Meteora portfolio + PnL APIs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Telegram library (send-only)

**Files:**
- Create: `companion/lib/telegram.js`

Smoke-verified (Task 11). Send-only — never polls `getUpdates` (main owns polling).

- [ ] **Step 1: Create `companion/lib/telegram.js`**

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "..", "..", "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function resolveChatId() {
  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) return cfg.telegramChatId;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

export function isEnabled() {
  return !!TOKEN && !!resolveChatId();
}

async function post(method, body) {
  const chatId = resolveChatId();
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      log("telegram_error", `${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  return post("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await post("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
    if (res) return res;
    if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  const plain = html.replace(/<\/?[bip]>/g, "").replace(/<[^>]+>/g, "");
  log("telegram_warn", "sendHTML failed, falling back to plain text");
  return post("sendMessage", { text: plain.slice(0, 4096) });
}
```

- [ ] **Step 2: Sanity-check no polling symbols exist**

```bash
grep -nE "getUpdates|startPolling|startPoll" companion/lib/telegram.js || echo "OK: send-only"
```

Expected: `OK: send-only`.

- [ ] **Step 3: Commit**

```bash
git add companion/lib/telegram.js
git commit -m "feat(companion): send-only Telegram library

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Swap library (Jupiter Swap V2)

**Files:**
- Create: `companion/lib/swap.js`

Smoke-verified via `DRY_RUN` (Task 11).

- [ ] **Step 1: Create `companion/lib/swap.js`**

Ported lean from `tools/wallet.js:swapToken`. Inlined slippage + API key from `config`; no `notify3rdPartyError`.

```js
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWallet } from "./balance.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";

let _connection = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" || mint === "native" || /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/** Swap tokens via Jupiter Swap V2 (order → sign → execute). Honors DRY_RUN. */
export async function swapToken({ input_mint, output_mint, amount }) {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (config.dryRun) {
    return { dry_run: true, would_swap: { input_mint, output_mint, amount }, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    let decimals = 9;
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    const orderUrl =
      `${JUPITER_SWAP_V2_API}/order` +
      `?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}` +
      `&taker=${wallet.publicKey.toString()}&slippageBps=${config.swap.slippageBps}`;
    const orderRes = await fetch(orderUrl, { headers: { "x-api-key": config.swap.apiKey } });
    if (!orderRes.ok) throw new Error(`Swap V2 order failed: ${orderRes.status} ${await orderRes.text()}`);
    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);

    const { transaction: unsignedTx, requestId } = order;
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.swap.apiKey },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    const result = await execRes.json();
    if (result.status === "Failed") throw new Error(`Swap failed on-chain: code=${result.code}`);

    log("swap", `SUCCESS tx: ${result.signature}`);
    return { success: true, tx: result.signature, input_mint, output_mint, amount_in: result.inputAmountResult, amount_out: result.outputAmountResult };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add companion/lib/swap.js
git commit -m "feat(companion): Jupiter swap library (DRY_RUN-aware)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Auditor feature

**Files:**
- Create: `companion/features/auditor.js`

Smoke-verified (Task 11).

- [ ] **Step 1: Create `companion/features/auditor.js`**

Adapted from `performance-auditor.js`; uses companion `lib/balance` + `lib/positions` + `db`.

```js
import { getWalletValue } from "../lib/balance.js";
import { getOnChainPositions } from "../lib/positions.js";
import { getWalletRepo } from "../db.js";
import { log } from "../logger.js";

/** Fetch balances + on-chain positions, write one daily snapshot row. Returns the snapshot or null. */
export async function runAudit() {
  try {
    const [balances, positionsResult] = await Promise.all([
      getWalletValue(),
      getOnChainPositions().catch(() => null),
    ]);

    if (balances.error) {
      log("auditor_error", `Wallet balance fetch failed: ${balances.error}`);
      return null;
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const positions = positionsResult?.positions || [];
    const positionsUsd = positionsResult?.total_value_usd ?? 0;
    const positionsSol = balances.sol_price > 0 ? positionsUsd / balances.sol_price : 0;

    const snapshot = {
      date,
      sol: balances.sol,
      sol_price: balances.sol_price,
      wallet_usd: balances.total_usd,
      positions_usd: positionsUsd,
      positions_sol: positionsSol,
      position_count: positions.length,
      grand_total_usd: balances.total_usd + positionsUsd,
      grand_total_sol: balances.sol + positionsSol,
    };

    getWalletRepo().insert(snapshot);
    log("auditor", `Snapshot recorded: ${date} — ${balances.sol.toFixed(4)} SOL wallet + ${positions.length} positions ($${snapshot.grand_total_usd.toFixed(2)} total)`);
    return snapshot;
  } catch (error) {
    log("auditor_error", `Audit failed: ${error.message}`);
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add companion/features/auditor.js
git commit -m "feat(companion): wallet auditor → SQLite snapshot

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Briefing feature (TDD)

**Files:**
- Create: `companion/features/briefing.js`
- Test: `companion/test/briefing.test.js`

`generateWalletBriefing(snapshots, opts)` is a pure function of a snapshots array (ascending by date) — fully unit-testable. `index.js`/`auditor` fetches snapshots from the repo and passes them in.

- [ ] **Step 1: Write the failing test**

`companion/test/briefing.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWalletBriefing } from "../features/briefing.js";

const snap = (date, grandUsd, grandSol, solPrice, count) => ({
  date, grand_total_usd: grandUsd, grand_total_sol: grandSol, sol_price: solPrice,
  wallet_usd: grandUsd, positions_usd: 0, positions_sol: 0, position_count: count, sol: grandSol,
});

test("renders today's totals and position count", () => {
  const html = generateWalletBriefing([snap("2026-07-01", 1600, 10, 150, 2)]);
  assert.match(html, /Wallet Briefing/);
  assert.match(html, /\$1,600\.00/);
  assert.match(html, /10\.0000 SOL/);
  assert.match(html, /2 open/);
});

test("renders 7d delta when history exists", () => {
  const html = generateWalletBriefing([
    snap("2026-06-24", 1500, 9, 150, 1),
    snap("2026-07-01", 1600, 10, 150, 2),
  ]);
  assert.match(html, /7d/);
  assert.match(html, /\+\$100\.00/);      // +$100 USD
  assert.match(html, /\+6\.7%/);          // +6.67% rounded to 1 dp
});

test("omits delta line when only one snapshot", () => {
  const html = generateWalletBriefing([snap("2026-07-01", 1600, 10, 150, 2)]);
  assert.doesNotMatch(html, /7d/);
});

test("renders 'no data' message when empty", () => {
  const html = generateWalletBriefing([]);
  assert.match(html, /No snapshot data yet/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd companion && node --test test/briefing.test.js
```

Expected: FAIL — `Cannot find module '../features/briefing.js'`.

- [ ] **Step 3: Implement `companion/features/briefing.js`**

```js
import { getWalletRepo } from "../db.js";

function fmtUsd(n) { return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtSol(n) { return `${Number(n).toFixed(4)} SOL`; }
function signedUsd(delta) { return `${delta >= 0 ? "+" : "-"}${fmtUsd(Math.abs(delta))}`; }
function signedPct(pct) { return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`; }

function deltaLine(label, fromSnap, toSnap) {
  const usdDelta = toSnap.grand_total_usd - fromSnap.grand_total_usd;
  const pct = fromSnap.grand_total_usd > 0 ? (usdDelta / fromSnap.grand_total_usd) * 100 : 0;
  return `• ${label}: ${signedUsd(usdDelta)} (${signedPct(pct)})`;
}

/**
 * Pure renderer. `snapshots` must be ascending by date.
 * Returns Telegram HTML for the wallet-value morning briefing.
 */
export function generateWalletBriefing(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return "📊 <b>Wallet Briefing</b>\n────────────────\nNo snapshot data yet. The auditor will create the first row on its next run.";
  }

  const latest = snapshots[snapshots.length - 1];
  const lines = [
    "📊 <b>Wallet Briefing</b>",
    "────────────────",
    `<b>Today (${latest.date}):</b>`,
    `💰 ${fmtUsd(latest.grand_total_usd)}  ·  ${fmtSol(latest.grand_total_sol)}  (@ $${latest.sol_price.toFixed(2)}/SOL)`,
    `📂 ${latest.position_count} open position(s)`,
  ];

  if (snapshots.length >= 2) {
    const today = new Date(latest.date);
    const pickBefore = (days) => {
      const target = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
      const before = snapshots.filter(s => s.date <= target);
      return before.length ? before[before.length - 1] : null;
    };
    const d7 = pickBefore(7);
    const d30 = pickBefore(30);
    lines.push("", "<b>Change:</b>");
    if (d7) lines.push(deltaLine("7d", d7, latest));
    if (d30) lines.push(deltaLine("30d", d30, latest));
    if (!d7 && !d30) lines.push(`• (not enough history yet — ${snapshots.length} snapshot(s))`);
  }

  lines.push("────────────────");
  return lines.join("\n");
}

/** Convenience: render from the repo's stored history (latest + trailing window). */
export function renderBriefingFromRepo() {
  const repo = getWalletRepo();
  const latest = repo.getLatest();
  if (!latest) return generateWalletBriefing([]);
  // fetch up to ~35 days of history ending at the latest snapshot
  const end = latest.date;
  const start = new Date(new Date(end).getTime() - 35 * 86400000).toISOString().slice(0, 10);
  return generateWalletBriefing(repo.getRange(start, end));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/briefing.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ..
git add companion/features/briefing.js companion/test/briefing.test.js
git commit -m "feat(companion): wallet-value morning briefing renderer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Dust cleanup feature

**Files:**
- Create: `companion/features/dust.js`

Smoke-verified via `DRY_RUN` (Task 11). Adapted from `tools/dust-cleanup.js`: drops `appendDecision`/`getTrackedPositions` (state.js), derives protection set on-chain via `lib/positions`, adds a Telegram summary. Wallet-wide writes only (never touches LP positions).

- [ ] **Step 1: Create `companion/features/dust.js`**

```js
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWalletValue } from "../lib/balance.js";
import { getOnChainPositions } from "../lib/positions.js";
import { swapToken } from "../lib/swap.js";
import { sendMessage } from "../lib/telegram.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const RENT_PER_ATA = 0.00207408; // SOL reclaimed per closed ATA (rent-exempt minimum)

let _connection = null;
let _wallet = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}
function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Sweep dust tokens → SOL and close empty ATAs to reclaim rent.
 * Protection set (tokens backing open positions) is derived ON-CHAIN (no state.json).
 */
export async function cleanDust() {
  const threshold = config.dust.thresholdUsd;
  const isDryRun = config.dryRun;
  const wallet = getWallet();
  const connection = getConnection();

  log("dust_cleanup", `Starting dust cleanup (threshold: $${threshold}, dry_run: ${isDryRun})`);

  const result = {
    success: true, dry_run: isDryRun, threshold_usd: threshold,
    swapped: [], swap_failed: [], accounts_closed: 0, rent_reclaimed_sol: 0,
    total_sol_gained: 0, skipped_protected: [], skipped_active_position: [],
  };

  try {
    const balances = await getWalletValue();
    if (balances.error) return { ...result, success: false, error: `Balance fetch failed: ${balances.error}` };

    const heliusMap = new Map();
    for (const t of balances.tokens) heliusMap.set(t.mint, { symbol: t.symbol, balance: t.balance, usd: t.usd });

    const [standardAccounts, token2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const ataMap = new Map();
    for (const { pubkey, account } of [...standardAccounts.value, ...token2022Accounts.value]) {
      const info = account.data.parsed.info;
      ataMap.set(info.mint, { ataAddress: pubkey, mint: info.mint, balance: info.tokenAmount?.uiAmount ?? 0, programId: account.owner.toString() });
    }

    // Protection set: base mints of OPEN positions (on-chain) — never sweep these.
    const positionsResult = await getOnChainPositions().catch(() => ({ positions: [] }));
    const activeMints = new Set(positionsResult.positions.map(p => p.base_mint).filter(Boolean));
    const protectedMints = new Set([config.tokens.SOL, config.tokens.USDC, config.tokens.USDT]);

    const swapCandidates = [];
    const closeCandidates = [];

    for (const [mint, ata] of ataMap) {
      if (protectedMints.has(mint)) { result.skipped_protected.push({ mint }); continue; }
      if (activeMints.has(mint)) { result.skipped_active_position.push({ mint }); continue; }
      const h = heliusMap.get(mint);
      const usdValue = h?.usd ?? null;
      const symbol = h?.symbol ?? mint.slice(0, 8);
      if (ata.balance > 0 && (usdValue === null || usdValue < threshold)) {
        swapCandidates.push({ ...ata, symbol, usdValue, heliusBalance: h?.balance ?? ata.balance });
      } else if (ata.balance === 0) {
        closeCandidates.push({ ...ata, symbol });
      }
    }

    log("dust_cleanup", `Found ${swapCandidates.length} swap candidates, ${closeCandidates.length} close candidates`);

    if (isDryRun) {
      const summary = `🧹 <b>Dust Cleanup</b> (DRY RUN)\n────────────────\nSwap candidates: ${swapCandidates.length}\nClose candidates: ${closeCandidates.length}\nProtected (active positions): ${result.skipped_active_position.length}\nNo transactions sent.`;
      await sendMessage(summary).catch(() => {});
      return { ...result, swap_candidates: swapCandidates, close_candidates: closeCandidates, message: "DRY RUN — no transactions sent" };
    }

    const solBalance = balances.sol;
    if (solBalance < config.gasReserve) {
      log("dust_cleanup", `SOL balance (${solBalance}) below gas reserve (${config.gasReserve}), skipping`);
      return { ...result, success: false, error: `SOL balance ${solBalance} below gas reserve ${config.gasReserve}` };
    }

    // Swap phase (sequential)
    for (const candidate of swapCandidates) {
      try {
        log("dust_cleanup", `Swapping ${candidate.heliusBalance} ${candidate.symbol} ($${candidate.usdValue ?? 0}) → SOL`);
        const swapResult = await swapToken({ input_mint: candidate.mint, output_mint: "SOL", amount: candidate.heliusBalance });
        if (swapResult.success === false) throw new Error(swapResult.error || "Swap returned unsuccessful");
        result.swapped.push({ mint: candidate.mint, symbol: candidate.symbol, amount: candidate.heliusBalance, usd_value: candidate.usdValue, tx: swapResult.tx ?? null, dry_run: !!swapResult.dry_run });
        await sleep(1000);
        const post = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(candidate.mint) });
        const remaining = post.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (remaining === 0 && post.value[0]) {
          closeCandidates.push({ mint: candidate.mint, symbol: candidate.symbol, ataAddress: post.value[0].pubkey, programId: candidate.programId });
        }
        await sleep(config.dust.swapDelayMs);
      } catch (error) {
        log("dust_cleanup_error", `Failed to swap ${candidate.symbol}: ${error.message}`);
        result.swap_failed.push({ mint: candidate.mint, symbol: candidate.symbol, error: error.message });
      }
    }

    // Close phase (batched)
    if (closeCandidates.length > 0) {
      const byProgram = new Map();
      for (const c of closeCandidates) {
        const pid = c.programId ?? TOKEN_PROGRAM_ID.toString();
        if (!byProgram.has(pid)) byProgram.set(pid, []);
        byProgram.get(pid).push(c);
      }
      for (const [programIdStr, accounts] of byProgram) {
        const tokenProgramId = new PublicKey(programIdStr);
        for (let i = 0; i < accounts.length; i += config.dust.batchSize) {
          const batch = accounts.slice(i, i + config.dust.batchSize);
          const tx = new Transaction();
          for (const acct of batch) {
            tx.add(createCloseAccountInstruction(acct.ataAddress, wallet.publicKey, wallet.publicKey, [], tokenProgramId));
          }
          try {
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
            result.accounts_closed += batch.length;
            log("dust_cleanup", `Closed batch of ${batch.length} accounts (tx: ${sig})`);
          } catch (error) {
            log("dust_cleanup_error", `Batch close failed: ${error.message} — retrying individually`);
            for (const acct of batch) {
              try {
                const single = new Transaction();
                single.add(createCloseAccountInstruction(acct.ataAddress, wallet.publicKey, wallet.publicKey, [], tokenProgramId));
                await sendAndConfirmTransaction(connection, single, [wallet], { commitment: "confirmed" });
                result.accounts_closed++;
              } catch {
                /* skip individual failures */
              }
            }
          }
        }
      }
    }

    result.rent_reclaimed_sol = parseFloat((result.accounts_closed * RENT_PER_ATA).toFixed(6));
    result.total_sol_gained = result.rent_reclaimed_sol;

    const summary =
      `🧹 <b>Dust Cleanup Complete</b>\n────────────────\n` +
      `🔁 Swapped: ${result.swapped.length}  ·  ❌ Failed: ${result.swap_failed.length}\n` +
      `🚪 ATAs closed: ${result.accounts_closed}\n` +
      `💎 Rent reclaimed: ${result.total_sol_gained.toFixed(6)} SOL\n` +
      `🛡 Protected (active positions): ${result.skipped_active_position.length}`;
    await sendMessage(summary).catch(() => {});

    log("dust_cleanup", `Complete: ${result.swapped.length} swapped, ${result.accounts_closed} closed, ${result.total_sol_gained} SOL reclaimed`);
    return result;
  } catch (error) {
    log("dust_cleanup_error", `Fatal: ${error.message}`);
    return { ...result, success: false, error: error.message };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add companion/features/dust.js
git commit -m "feat(companion): dust cleanup (on-chain protection, telegram summary)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Entry point + smoke harness

**Files:**
- Create: `companion/index.js`

Provides `--run <job>` (smoke) and cron registration (production).

- [ ] **Step 1: Create `companion/index.js`**

```js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";

import { log } from "./logger.js";
import { config } from "./config.js";
import { init, close } from "./db.js";
import { runAudit } from "./features/auditor.js";
import { renderBriefingFromRepo } from "./features/briefing.js";
import { cleanDust } from "./features/dust.js";
import { sendHTML, isEnabled } from "./lib/telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the SHARED ../.env (single source of truth for secrets).
dotenv.config({ path: path.join(__dirname, "..", ".env") });

function validateEnv() {
  const required = ["WALLET_PRIVATE_KEY", "RPC_URL", "HELIUS_API_KEY"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    log("startup_error", `Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!isEnabled()) log("startup_warn", "Telegram not fully configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — messages will be skipped.");
}

async function runJob(name) {
  log("job", `Running ${name}`);
  try {
    if (name === "audit") return await runAudit();
    if (name === "briefing") {
      const html = renderBriefingFromRepo();
      if (isEnabled()) await sendHTML(html);
      else log("briefing", "Telegram disabled — briefing not sent");
      return html;
    }
    if (name === "dust") return await cleanDust();
    throw new Error(`Unknown job: ${name}`);
  } catch (error) {
    log("job_error", `${name} failed: ${error.message}`);
    return null;
  }
}

// ─── Smoke harness: node index.js --run <audit|briefing|dust> ──────────────
const runArg = process.argv.find(a => a.startsWith("--run"));
if (runArg) {
  const job = runArg.split("=")[1] || process.argv[process.argv.indexOf(runArg) + 1];
  validateEnv();
  init();
  log("startup", `Smoke run: ${job} (DRY_RUN=${config.dryRun})`);
  const res = await runJob(job);
  log("startup", `Smoke complete: ${job}`);
  close();
  process.exit(0);
}

// ─── Production: cron schedules ────────────────────────────────────────────
validateEnv();
init();
log("startup", `Companion started (DRY_RUN=${config.dryRun}). audit=${config.schedule.auditCron} briefing=${config.schedule.briefingCron} dust=${config.schedule.dustCron}`);

cron.schedule(config.schedule.auditCron, () => runJob("audit"));
cron.schedule(config.schedule.briefingCron, () => runJob("briefing"));
cron.schedule(config.schedule.dustCron, () => runJob("dust"));

process.on("SIGINT", () => { log("startup", "SIGINT — shutting down"); close(); process.exit(0); });
process.on("SIGTERM", () => { log("startup", "SIGTERM — shutting down"); close(); process.exit(0); });

// Keep the event loop alive (cron schedules are enough, but be explicit).
log("startup", "Companion idling, waiting for scheduled jobs.");
```

- [ ] **Step 2: Run the unit test suite (everything wires together)**

```bash
cd companion && npm test
```

Expected: PASS — config (5), wallet-snapshot (5), briefing (4) = 14 tests, 0 failing.

- [ ] **Step 3: DRY_RUN smoke — audit**

```bash
node index.js --run audit
```

Expected: log line `Snapshot recorded: <today> — <SOL> SOL wallet + <N> positions ($<total> total)`. Confirm a row was written:

```bash
node -e "import('better-sqlite3').then(async m=>{const Database=m.default;const db=new Database('data/companion.db');console.log(db.prepare('SELECT date,sol,grand_total_usd FROM wallet_snapshots ORDER BY date DESC LIMIT 3').all());})"
```

Expected: a row with today's date.

- [ ] **Step 4: DRY_RUN smoke — briefing**

```bash
node index.js --run briefing
```

Expected: the wallet briefing HTML is logged and (if Telegram configured) sent to the chat.

- [ ] **Step 5: DRY_RUN smoke — dust**

```bash
DRY_RUN=true node index.js --run dust
```

Expected: log lines for swap/close candidate counts and a `🧹 Dust Cleanup (DRY RUN)` summary; if Telegram configured, the summary is sent. No on-chain transactions.

- [ ] **Step 6: Commit**

```bash
cd ..
git add companion/index.js
git commit -m "feat(companion): entry point with cron + --run smoke harness

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: PM2 ecosystem + README + final verification

**Files:**
- Create: `companion/ecosystem.config.cjs`, `companion/README.md`

> The ecosystem file uses a **`.cjs`** extension on purpose: `companion/package.json` sets `"type":"module"`, which would make a `.js` file ESM — but PM2 `require()`s the config as CommonJS and `__dirname` is undefined under ESM. The `.cjs` extension forces CommonJS so `__dirname` resolves correctly.

- [ ] **Step 1: Create `companion/ecosystem.config.cjs`**

Launches BOTH main and companion from one PM2 file, root untouched.

```js
module.exports = {
  apps: [
    {
      name: "meridian-main",
      cwd: __dirname + "/..",
      script: "index.js",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "meridian-companion",
      cwd: __dirname,
      script: "index.js",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
```

- [ ] **Step 2: Create `companion/README.md`**

````markdown
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
````

- [ ] **Step 3: Final full test run**

```bash
cd companion && npm test
```

Expected: 14 tests pass, 0 failing.

- [ ] **Step 4: Verify isolation invariants**

```bash
# (a) companion never imports main source
grep -rnE "from ['\"]\.\./(index|config|state|agent|tools|db|logger|telegram|briefing|lessons|pool-memory)" companion/ companion/lib companion/features companion/test 2>/dev/null || echo "OK: no main-source imports"
# (b) companion never polls Telegram
grep -rnE "getUpdates|startPolling" companion/ || echo "OK: send-only"
# (c) root untouched by companion work
git diff --name-only main..companion | grep -vE "^companion/|^docs/superpowers/" || echo "OK: only companion/ + docs changed"
```

Expected: all three print `OK: ...`.

- [ ] **Step 5: Commit + final summary**

```bash
cd ..
git add companion/ecosystem.config.cjs companion/README.md
git commit -m "feat(companion): PM2 ecosystem (main+companion) + README

Co-Authored-By: Claude <noreply@anthropic.com>"
git log --oneline main..companion
```

Expected: ~12 commits, all under `companion/` (+ the spec under `docs/`).

---

## Definition of Done

- [ ] `npm test` in `companion/` passes (14 tests).
- [ ] `node companion/index.js --run audit` writes today's snapshot; `--run briefing` renders/sends; `DRY_RUN=true --run dust` reports candidates without transacting.
- [ ] Companion imports no main source; never polls Telegram; only `companion/` + `docs/` differ from `main`.
- [ ] `pm2 start companion/ecosystem.config.cjs` launches both `meridian-main` and `meridian-companion`.
- [ ] Spec open items resolved: schedules kept as designed (01:57 / 02:03 / every-12h); dust threshold default $0.10; upstream remote URL added during first sync (documented in companion README).
