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
