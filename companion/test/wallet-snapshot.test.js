import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate, createWalletSnapshotRepo } from "../wallet-snapshot.js";

function makeRepo() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, repo: createWalletSnapshotRepo(db) };
}

const snapshot = (date, sol, total) => ({
  date, sol, sol_price: 150, wallet_usd: sol * 150,
  positions_usd: total - sol * 150, positions_sol: 0,
  position_count: 1, grand_total_usd: total, grand_total_sol: sol,
});

test("insert then get returns the snapshot", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  assert.equal(repo.get("2026-07-01").sol, 10);
});

test("insert upserts on same date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.insert(snapshot("2026-07-01", 12, 1800));
  const got = repo.get("2026-07-01");
  assert.equal(got.sol, 12);
  assert.equal(repo.getLatest().sol, 12);
});

test("getLatest returns null when empty", () => {
  const { repo } = makeRepo();
  assert.equal(repo.getLatest(), null);
});

test("getRange returns ascending by date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-03", 10, 1600));
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.insert(snapshot("2026-07-02", 10, 1600));
  const range = repo.getRange("2026-07-01", "2026-07-03");
  assert.deepEqual(range.map(r => r.date), ["2026-07-01", "2026-07-02", "2026-07-03"]);
});

test("delete removes a date", () => {
  const { repo } = makeRepo();
  repo.insert(snapshot("2026-07-01", 10, 1600));
  repo.delete("2026-07-01");
  assert.equal(repo.get("2026-07-01"), null);
});
