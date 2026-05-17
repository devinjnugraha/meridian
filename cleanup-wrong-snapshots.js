// One-time script: delete old v1 snapshots that lack LP position data.
// Run: node cleanup-wrong-snapshots.js
//
// This drops the old wallet_snapshots table and recreates it with the new schema.
// Only use if you have < a few days of data from the initial v1 auditor.

import MeridianDB from "./db.js";
import fs from "fs";

const db = MeridianDB.getInstance();

// Drop and recreate — clean slate
db._db.exec(`DROP TABLE IF EXISTS wallet_snapshots`);
db._db.exec(`
  CREATE TABLE wallet_snapshots (
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
  CREATE INDEX idx_wallet_snapshots_date ON wallet_snapshots(date);
`);

console.log("Old snapshots wiped. New schema ready.");

db.close();

// Clean up stale WAL/SHM files
for (const ext of ["-wal", "-shm"]) {
  const f = `./data/meridian.db${ext}`;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log("Done. Next runAudit() will record the first proper snapshot.");
