// One-time script: wipe old snapshots and recreate with current schema.
// Run: node cleanup-wrong-snapshots.js

import Database from "better-sqlite3";
import fs from "fs";
import { init, close, getWalletRepo } from "./db.js";

// Drop the table raw — outside the repo layer since this is a destructive schema op.
const raw = new Database("./data/meridian.db");
raw.exec(`DROP TABLE IF EXISTS wallet_snapshots`);
raw.close();

// Clean up WAL/SHM so next open is truly fresh
for (const ext of ["-wal", "-shm"]) {
  const f = `./data/meridian.db${ext}`;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// Now open properly — init() will run migrations and create fresh schema
init();
const repo = getWalletRepo();
console.log("Old snapshots wiped. Schema:");
console.log(repo.getLatest() === null ? "Empty — ready for first snapshot." : "Unexpected data found.");
close();

console.log("Done. Next runAudit() will record the first proper snapshot.");
