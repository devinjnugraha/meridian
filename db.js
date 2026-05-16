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
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT    NOT NULL UNIQUE,
        sol        REAL    NOT NULL,
        sol_price  REAL    NOT NULL,
        sol_usd    REAL    NOT NULL,
        total_usd  REAL    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_date ON wallet_snapshots(date);
    `);
  }

  // ── Wallet Snapshots ────────────────────────────────────────

  insertWalletSnapshot({ date, sol, sol_price, sol_usd, total_usd }) {
    this._stmt("upsert_snapshot").run(date, sol, sol_price, sol_usd, total_usd);
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
        INSERT INTO wallet_snapshots (date, sol, sol_price, sol_usd, total_usd)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          sol = excluded.sol, sol_price = excluded.sol_price,
          sol_usd = excluded.sol_usd, total_usd = excluded.total_usd`,
      get_snapshot: `SELECT * FROM wallet_snapshots WHERE date = ?`,
      latest_snapshot: `SELECT * FROM wallet_snapshots ORDER BY date DESC LIMIT 1`,
      range_snapshots: `SELECT * FROM wallet_snapshots WHERE date >= ? AND date <= ? ORDER BY date ASC`,
    }[name];
    if (!sql) throw new Error(`Unknown statement: ${name}`);
    return this._db.prepare(sql);
  }
}

export default MeridianDB;
