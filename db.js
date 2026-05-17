import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const DEFAULT_DB_PATH = "./data/meridian.db";

class MeridianDB {
  static _instance = null;

  /** @returns {MeridianDB} */
  static getInstance(dbPath) {
    if (!MeridianDB._instance) {
      MeridianDB._instance = new MeridianDB(dbPath || DEFAULT_DB_PATH);
    }
    return MeridianDB._instance;
  }

  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this._db = new Database(dbPath);
    this._db.pragma("journal_mode = WAL");
    this._migrate();
  }

  // ── Migrations ──────────────────────────────────────────────

  _migrate() {
    this._db.exec(`
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

    // Migration: add columns if upgrading from v1 schema
    const cols = this._db.pragma("table_info(wallet_snapshots)").map(c => c.name);
    if (!cols.includes("wallet_usd")) {
      this._db.exec(`ALTER TABLE wallet_snapshots RENAME COLUMN total_usd TO wallet_usd`);
    }
    if (!cols.includes("positions_usd")) {
      this._db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN positions_usd REAL NOT NULL DEFAULT 0`);
    }
    if (!cols.includes("positions_sol")) {
      this._db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN positions_sol REAL NOT NULL DEFAULT 0`);
    }
    if (!cols.includes("position_count")) {
      this._db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN position_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes("grand_total_usd")) {
      this._db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN grand_total_usd REAL NOT NULL`);
      this._db.exec(`UPDATE wallet_snapshots SET grand_total_usd = wallet_usd + positions_usd WHERE grand_total_usd IS NULL`);
    }
    if (!cols.includes("grand_total_sol")) {
      this._db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN grand_total_sol REAL NOT NULL DEFAULT 0`);
      this._db.exec(`UPDATE wallet_snapshots SET grand_total_sol = sol + positions_sol WHERE grand_total_sol = 0 AND sol + positions_sol > 0`);
    }
    // Drop old sol_usd if it still exists (replaced by wallet_usd)
    if (cols.includes("sol_usd") && cols.includes("wallet_usd")) {
      // SQLite doesn't support DROP COLUMN before 3.35.0, but better-sqlite3
      // ships with a recent version — safe to ignore if it fails
      try { this._db.exec(`ALTER TABLE wallet_snapshots DROP COLUMN sol_usd`); } catch { /* already gone or unsupported */ }
    }
  }

  // ── Wallet Snapshots ────────────────────────────────────────

  insertWalletSnapshot({ date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol }) {
    this._stmt("upsert_snapshot").run(date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol);
  }

  getSnapshot(date) {
    return this._stmt("get_snapshot").get(date) ?? null;
  }

  getLatestSnapshot() {
    return this._stmt("latest_snapshot").get() ?? null;
  }

  getSnapshotsRange(fromDate, toDate) {
    return this._stmt("range_snapshots").all(fromDate, toDate);
  }

  deleteSnapshot(date) {
    this._stmt("delete_snapshot").run(date);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close() {
    this._db.close();
    MeridianDB._instance = null;
  }

  // ── Prepared Statement Cache ────────────────────────────────

  _stmts = {};

  _stmt(name) {
    if (!this._stmts[name]) this._stmts[name] = this._prepare(name);
    return this._stmts[name];
  }

  _prepare(name) {
    const sql = {
      upsert_snapshot: `
        INSERT INTO wallet_snapshots (date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          sol = excluded.sol, sol_price = excluded.sol_price,
          wallet_usd = excluded.wallet_usd, positions_usd = excluded.positions_usd,
          positions_sol = excluded.positions_sol, position_count = excluded.position_count,
          grand_total_usd = excluded.grand_total_usd, grand_total_sol = excluded.grand_total_sol`,
      get_snapshot: `SELECT * FROM wallet_snapshots WHERE date = ?`,
      latest_snapshot: `SELECT * FROM wallet_snapshots ORDER BY date DESC LIMIT 1`,
      range_snapshots: `SELECT * FROM wallet_snapshots WHERE date >= ? AND date <= ? ORDER BY date ASC`,
      delete_snapshot: `DELETE FROM wallet_snapshots WHERE date = ?`,
    }[name];
    if (!sql) throw new Error(`Unknown statement: ${name}`);
    return this._db.prepare(sql);
  }
}

export default MeridianDB;
