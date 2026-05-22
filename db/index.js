import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { migrate as migrateWallet, createWalletSnapshotRepo } from "./wallet-snapshot.js";
import { migrate as migrateLesson, createLessonRepo } from "./lesson.js";

const DEFAULT_DB_PATH = "./data/meridian.db";

let _db = null;
let _walletRepo = null;
let _lessonRepo = null;

export function init(dbPath) {
  if (_db) return;

  const resolved = dbPath || DEFAULT_DB_PATH;
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(resolved);
  _db.pragma("journal_mode = WAL");

  migrateWallet(_db);
  migrateLesson(_db);

  _walletRepo = createWalletSnapshotRepo(_db);
  _lessonRepo = createLessonRepo(_db);
}

function _ensure() {
  if (!_db) init();
}

export function close() {
  if (_db) {
    _db.close();
    _db = null;
    _walletRepo = null;
    _lessonRepo = null;
  }
}

export function getWalletRepo() {
  _ensure();
  return _walletRepo;
}

export function getLessonRepo() {
  _ensure();
  return _lessonRepo;
}

export function withTransaction(fn) {
  _ensure();
  return _db.transaction(fn)();
}
