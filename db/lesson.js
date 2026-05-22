export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_records (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      position          TEXT    NOT NULL,
      pool              TEXT,
      pool_name         TEXT,
      base_mint         TEXT,
      strategy          TEXT,
      bin_range         TEXT,
      bin_step          REAL,
      volatility        REAL,
      fee_tvl_ratio     REAL,
      organic_score     REAL,
      amount_sol        REAL,
      fees_earned_usd   REAL,
      fees_earned_sol   REAL,
      final_value_usd   REAL,
      initial_value_usd REAL,
      pnl_usd           REAL,
      pnl_pct           REAL,
      minutes_in_range  REAL,
      minutes_held      REAL,
      range_efficiency  REAL,
      close_reason      TEXT,
      signal_snapshot   TEXT,
      swap_sol_received REAL,
      swap_amount_in    REAL,
      swap_tx           TEXT,
      deployed_at       TEXT,
      recorded_at       TEXT    NOT NULL,
      UNIQUE(position)
    );
    CREATE INDEX IF NOT EXISTS idx_perf_pool ON performance_records(pool);
    CREATE INDEX IF NOT EXISTS idx_perf_recorded ON performance_records(recorded_at);

    CREATE TABLE IF NOT EXISTS lessons (
      id                INTEGER PRIMARY KEY,
      rule              TEXT    NOT NULL,
      tags              TEXT,
      outcome           TEXT,
      source_type       TEXT,
      confidence        REAL,
      context           TEXT,
      pnl_pct           REAL,
      fees_earned_usd   REAL,
      initial_value_usd REAL,
      range_efficiency  REAL,
      close_reason      TEXT,
      pool              TEXT,
      pinned            INTEGER NOT NULL DEFAULT 0,
      role              TEXT,
      created_at        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome);
    CREATE INDEX IF NOT EXISTS idx_lessons_pool ON lessons(pool);
  `);

  const perfCols = db.pragma("table_info(performance_records)").map(c => c.name);
  if (perfCols.length > 0 && !perfCols.includes("deployed_at")) {
    db.exec(`ALTER TABLE performance_records ADD COLUMN deployed_at TEXT`);
  }
}

function _parseJSON(val) {
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

function _perfRow(row) {
  return {
    ...row,
    bin_range: _parseJSON(row.bin_range),
    signal_snapshot: _parseJSON(row.signal_snapshot),
  };
}

function _lessonRow(row) {
  return {
    ...row,
    tags: _parseJSON(row.tags),
    sourceType: row.source_type,
    pinned: !!row.pinned,
  };
}

export function createLessonRepo(db) {
  const stmts = {
    // Performance writes
    insertPerformance: db.prepare(`
      INSERT INTO performance_records (
        position, pool, pool_name, base_mint,
        strategy, bin_range, bin_step, volatility, fee_tvl_ratio,
        organic_score, amount_sol, fees_earned_usd, fees_earned_sol,
        final_value_usd, initial_value_usd,
        pnl_usd, pnl_pct, minutes_in_range, minutes_held, range_efficiency,
        close_reason, signal_snapshot,
        swap_sol_received, swap_amount_in, swap_tx,
        deployed_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

    updatePerfSwap: db.prepare(`
      UPDATE performance_records
      SET swap_sol_received = ?, swap_amount_in = ?, swap_tx = ?
      WHERE position = ?
      ORDER BY id DESC LIMIT 1`),

    // Lesson writes
    insertLesson: db.prepare(`
      INSERT INTO lessons (
        id, rule, tags, outcome, source_type, confidence, context,
        pnl_pct, fees_earned_usd, initial_value_usd, range_efficiency,
        close_reason, pool, pinned, role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rule = excluded.rule, tags = excluded.tags,
        outcome = excluded.outcome, pinned = excluded.pinned,
        role = excluded.role`),

    updateLessonPin: db.prepare(`UPDATE lessons SET pinned = ? WHERE id = ?`),
    deleteLesson: db.prepare(`DELETE FROM lessons WHERE id = ?`),
    deleteLessonsKeyword: db.prepare(`DELETE FROM lessons WHERE rule LIKE ?`),
    deleteAllLessons: db.prepare(`DELETE FROM lessons`),
    deleteAllPerformance: db.prepare(`DELETE FROM performance_records`),

    // Performance reads
    getAllPerformance: db.prepare(`SELECT * FROM performance_records ORDER BY recorded_at ASC`),
    getPerformanceCount: db.prepare(`SELECT COUNT(*) as count FROM performance_records`),
    getPerformanceByPosition: db.prepare(`SELECT * FROM performance_records WHERE position = ? ORDER BY id DESC LIMIT 1`),
    getPerformanceSince: db.prepare(`SELECT * FROM performance_records WHERE recorded_at >= ? ORDER BY recorded_at ASC LIMIT ?`),
    getPerformanceSummary: db.prepare(`
      SELECT
        COUNT(*)                                          AS total_count,
        COALESCE(SUM(pnl_usd), 0)                         AS total_pnl_usd,
        COALESCE(AVG(pnl_pct), 0)                         AS avg_pnl_pct,
        COALESCE(AVG(range_efficiency), 0)                AS avg_range_efficiency,
        SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END)     AS win_count
      FROM performance_records`),

    // Lesson reads
    getAllLessons: db.prepare(`SELECT * FROM lessons ORDER BY created_at ASC`),
    getLessonCount: db.prepare(`SELECT COUNT(*) as count FROM lessons`),
    getLessonById: db.prepare(`SELECT * FROM lessons WHERE id = ?`),
  };

  return {
    // ── Performance Writes ──

    insertPerformance(rec) {
      stmts.insertPerformance.run(
        rec.position, rec.pool, rec.pool_name, rec.base_mint ?? null,
        rec.strategy ?? null, rec.bin_range != null ? JSON.stringify(rec.bin_range) : null,
        rec.bin_step ?? null, rec.volatility ?? null, rec.fee_tvl_ratio ?? null,
        rec.organic_score ?? null, rec.amount_sol ?? null,
        rec.fees_earned_usd ?? null, rec.fees_earned_sol ?? null,
        rec.final_value_usd ?? null, rec.initial_value_usd ?? null,
        rec.pnl_usd ?? null, rec.pnl_pct ?? null,
        rec.minutes_in_range ?? null, rec.minutes_held ?? null,
        rec.range_efficiency ?? null, rec.close_reason ?? null,
        rec.signal_snapshot ? JSON.stringify(rec.signal_snapshot) : null,
        rec.swap_sol_received ?? null, rec.swap_amount_in ?? null, rec.swap_tx ?? null,
        rec.deployed_at ?? null, rec.recorded_at,
      );
    },

    updatePerformanceSwap(position, swapSolReceived, swapAmountIn, swapTx) {
      stmts.updatePerfSwap.run(swapSolReceived, swapAmountIn, swapTx, position);
    },

    // ── Lesson Writes ──

    insertLesson(l) {
      stmts.insertLesson.run(
        l.id, l.rule, l.tags ? JSON.stringify(l.tags) : null,
        l.outcome ?? null, l.sourceType ?? null,
        l.confidence ?? null, l.context ?? null,
        l.pnl_pct ?? null, l.fees_earned_usd ?? null,
        l.initial_value_usd ?? null, l.range_efficiency ?? null,
        l.close_reason ?? null, l.pool ?? null,
        l.pinned ? 1 : 0, l.role ?? null,
        l.created_at,
      );
    },

    updateLessonPin(id, pinned) {
      stmts.updateLessonPin.run(pinned ? 1 : 0, id);
    },

    deleteLesson(id) {
      stmts.deleteLesson.run(id);
    },

    deleteLessonsByKeyword(keyword) {
      return stmts.deleteLessonsKeyword.run(`%${keyword}%`);
    },

    deleteAllLessons() {
      stmts.deleteAllLessons.run();
    },

    deleteAllPerformance() {
      stmts.deleteAllPerformance.run();
    },

    // ── Performance Reads ──

    getAllPerformance() {
      return stmts.getAllPerformance.all().map(_perfRow);
    },

    getPerformanceCount() {
      return stmts.getPerformanceCount.get().count;
    },

    getPerformanceByPosition(position) {
      const row = stmts.getPerformanceByPosition.get(position);
      return row ? _perfRow(row) : null;
    },

    getPerformanceSince(cutoff, limit) {
      return stmts.getPerformanceSince.all(cutoff, limit).map(_perfRow);
    },

    getPerformanceSummary() {
      const row = stmts.getPerformanceSummary.get();
      if (!row || row.total_count === 0) return null;
      return {
        total_positions_closed: row.total_count,
        total_pnl_usd: Math.round(row.total_pnl_usd * 100) / 100,
        avg_pnl_pct: Math.round(row.avg_pnl_pct * 100) / 100,
        avg_range_efficiency_pct: Math.round(row.avg_range_efficiency * 10) / 10,
        win_rate_pct: Math.round((row.win_count / row.total_count) * 100),
        total_lessons: stmts.getLessonCount.get().count,
      };
    },

    // ── Lesson Reads ──

    getAllLessons() {
      return stmts.getAllLessons.all().map(_lessonRow);
    },

    getLessonCount() {
      return stmts.getLessonCount.get().count;
    },

    getLessonById(id) {
      const row = stmts.getLessonById.get(id);
      return row ? _lessonRow(row) : null;
    },
  };
}
