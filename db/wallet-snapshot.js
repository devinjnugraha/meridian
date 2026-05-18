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

  const cols = db.pragma("table_info(wallet_snapshots)").map(c => c.name);
  if (!cols.includes("wallet_usd")) {
    db.exec(`ALTER TABLE wallet_snapshots RENAME COLUMN total_usd TO wallet_usd`);
  }
  if (!cols.includes("positions_usd")) {
    db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN positions_usd REAL NOT NULL DEFAULT 0`);
  }
  if (!cols.includes("positions_sol")) {
    db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN positions_sol REAL NOT NULL DEFAULT 0`);
  }
  if (!cols.includes("position_count")) {
    db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN position_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes("grand_total_usd")) {
    db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN grand_total_usd REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE wallet_snapshots SET grand_total_usd = wallet_usd + positions_usd`);
  }
  if (!cols.includes("grand_total_sol")) {
    db.exec(`ALTER TABLE wallet_snapshots ADD COLUMN grand_total_sol REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE wallet_snapshots SET grand_total_sol = sol + positions_sol WHERE grand_total_sol = 0 AND sol + positions_sol > 0`);
  }
  if (cols.includes("sol_usd") && cols.includes("wallet_usd")) {
    try { db.exec(`ALTER TABLE wallet_snapshots DROP COLUMN sol_usd`); } catch { /* already gone or unsupported */ }
  }
}

export const statements = {
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
};

export function insert(meridiandb, { date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol }) {
  meridiandb._stmt("upsert_snapshot").run(date, sol, sol_price, wallet_usd, positions_usd, positions_sol, position_count, grand_total_usd, grand_total_sol);
}

export function get(meridiandb, date) {
  return meridiandb._stmt("get_snapshot").get(date) ?? null;
}

export function getLatest(meridiandb) {
  return meridiandb._stmt("latest_snapshot").get() ?? null;
}

export function getRange(meridiandb, fromDate, toDate) {
  return meridiandb._stmt("range_snapshots").all(fromDate, toDate);
}

export function delete_(meridiandb, date) {
  meridiandb._stmt("delete_snapshot").run(date);
}

// Alias since `delete` is a reserved word
export { delete_ as delete };
