import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWalletBriefing } from "../features/briefing.js";

const snap = (date, grandUsd, grandSol, solPrice, count) => ({
  date, grand_total_usd: grandUsd, grand_total_sol: grandSol, sol_price: solPrice,
  wallet_usd: grandUsd, positions_usd: 0, positions_sol: 0, position_count: count, sol: grandSol,
});

test("renders today's totals and position count", () => {
  const html = generateWalletBriefing([snap("2026-07-01", 1600, 10, 150, 2)]);
  assert.match(html, /Wallet Briefing/);
  assert.match(html, /\$1,600\.00/);
  assert.match(html, /10\.0000 SOL/);
  assert.match(html, /2 open/);
});

test("renders 7d delta when history exists", () => {
  const html = generateWalletBriefing([
    snap("2026-06-24", 1500, 9, 150, 1),
    snap("2026-07-01", 1600, 10, 150, 2),
  ]);
  assert.match(html, /7d/);
  assert.match(html, /\+\$100\.00/);      // +$100 USD
  assert.match(html, /\+6\.7%/);          // +6.67% rounded to 1 dp
});

test("omits delta line when only one snapshot", () => {
  const html = generateWalletBriefing([snap("2026-07-01", 1600, 10, 150, 2)]);
  assert.doesNotMatch(html, /7d/);
});

test("renders 'no data' message when empty", () => {
  const html = generateWalletBriefing([]);
  assert.match(html, /No snapshot data yet/);
});
