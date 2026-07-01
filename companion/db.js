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
