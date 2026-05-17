// One-time script: wipe old snapshots and recreate with current schema.
// Run: node cleanup-wrong-snapshots.js

import Database from "better-sqlite3";
import MeridianDB from "./db.js";
import fs from "fs";

// Bypass MeridianDB constructor (its migration would fail on the old table).
// Open raw, drop, close, then let MeridianDB create fresh.
const raw = new Database("./data/meridian.db");
raw.exec(`DROP TABLE IF EXISTS wallet_snapshots`);
raw.close();

// Clean up WAL/SHM so next open is truly fresh
for (const ext of ["-wal", "-shm"]) {
  const f = `./data/meridian.db${ext}`;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// Now open properly — _migrate() will CREATE TABLE from scratch
const db = MeridianDB.getInstance();
console.log("Old snapshots wiped. Schema:");
console.log(db.getLatestSnapshot() === null ? "Empty — ready for first snapshot." : "Unexpected data found.");
db.close();

console.log("Done. Next runAudit() will record the first proper snapshot.");
