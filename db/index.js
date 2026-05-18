import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import * as WalletSnapshotRepo from "./wallet-snapshot.js";
import * as LessonRepo from "./lesson.js";

const DEFAULT_DB_PATH = "./data/meridian.db";

const REPOS = [WalletSnapshotRepo, LessonRepo];

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

    // Collect all SQL statements from repos into one map
    this._sql = {};
    for (const repo of REPOS) {
      Object.assign(this._sql, repo.statements);
    }

    this._migrate();
  }

  _migrate() {
    for (const repo of REPOS) {
      if (repo.migrate) repo.migrate(this._db);
    }
  }

  // ── Wallet Snapshots ────────────────────────────────────────

  insertWalletSnapshot(data) {
    WalletSnapshotRepo.insert(this, data);
  }

  getSnapshot(date) {
    return WalletSnapshotRepo.get(this, date);
  }

  getLatestSnapshot() {
    return WalletSnapshotRepo.getLatest(this);
  }

  getSnapshotsRange(fromDate, toDate) {
    return WalletSnapshotRepo.getRange(this, fromDate, toDate);
  }

  deleteSnapshot(date) {
    WalletSnapshotRepo.delete(this, date);
  }

  // ── Performance Records ─────────────────────────────────────

  insertPerformance(rec) {
    LessonRepo.insertPerformance(this, rec);
  }

  updatePerformanceSwap(position, swapSolReceived, swapAmountIn, swapTx) {
    LessonRepo.updatePerformanceSwap(this, position, swapSolReceived, swapAmountIn, swapTx);
  }

  // ── Lessons ──────────────────────────────────────────────────

  insertLesson(l) {
    LessonRepo.insertLesson(this, l);
  }

  updateLessonPin(id, pinned) {
    LessonRepo.updateLessonPin(this, id, pinned);
  }

  deleteLesson(id) {
    LessonRepo.deleteLesson(this, id);
  }

  deleteLessonsByKeyword(keyword) {
    return LessonRepo.deleteLessonsByKeyword(this, keyword);
  }

  deleteAllLessons() {
    LessonRepo.deleteAllLessons(this);
  }

  deleteAllPerformance() {
    LessonRepo.deleteAllPerformance(this);
  }

  // ── Performance Reads ───────────────────────────────────────

  getAllPerformance() {
    return LessonRepo.getAllPerformance(this);
  }

  getPerformanceCount() {
    return LessonRepo.getPerformanceCount(this);
  }

  getPerformanceByPosition(position) {
    return LessonRepo.getPerformanceByPosition(this, position);
  }

  getPerformanceSince(cutoff, limit) {
    return LessonRepo.getPerformanceSince(this, cutoff, limit);
  }

  getPerformanceSummary() {
    return LessonRepo.getPerformanceSummary(this);
  }

  // ── Lesson Reads ────────────────────────────────────────────

  getAllLessons() {
    return LessonRepo.getAllLessons(this);
  }

  getLessonCount() {
    return LessonRepo.getLessonCount(this);
  }

  getLessonById(id) {
    return LessonRepo.getLessonById(this, id);
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
    const sql = this._sql[name];
    if (!sql) throw new Error(`Unknown statement: ${name}`);
    return this._db.prepare(sql);
  }
}

export default MeridianDB;
