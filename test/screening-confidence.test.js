/**
 * Unit tests for the screening autopilot confidence scoring (screening-confidence.js).
 * Run: npm run test:unit
 *
 * Assertions avoid absolute degen values — degenScore scales with the live
 * config.screening.timeframe, so these tests check arithmetic relative to a
 * locally computed degenScore, blocker semantics, and selection logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCandidateConfidence, pickAutoDeployCandidate } from "../screening-confidence.js";
import { degenScore } from "../tools/screening.js";

const TARGETS = {
  targetVolRatio: 20,
  targetLpCount: 40,
  targetFeeRatio: 0.20,
  targetLiquidity: 20000,
};

function strongPool(name) {
  return {
    name,
    active_tvl: 50000,
    volume_window: 120000,
    fee_active_tvl_ratio: 0.9,
    unique_lps: 60,
    positions_created: 40,
    volatility: 3,
  };
}

test("score = degen + smart wallet bonus + narrative bonus", () => {
  const pool = strongPool("A");
  const ctx = { pool, sw: { in_pool: [{ name: "kol" }] }, n: { narrative: "real event" } };
  const opts = { degenTargets: TARGETS, smartWalletBonus: 20, narrativeBonus: 10 };
  const conf = computeCandidateConfidence(ctx, opts);
  const expected = Math.round((degenScore(pool, TARGETS) + 20 + 10) * 10) / 10;
  assert.equal(conf.score, expected);
  assert.equal(conf.degen, degenScore(pool, TARGETS));
  assert.equal(conf.hasNarrative, true);
  assert.equal(conf.smartWallets.length, 1);
  assert.deepEqual(conf.blockers, []);
  assert.ok(conf.breakdown.some((b) => b.startsWith("degen")));
  assert.ok(conf.breakdown.some((b) => b.includes("smart wallets")));
  assert.ok(conf.breakdown.some((b) => b.includes("narrative")));
});

test("bonuses only apply when the signal is present", () => {
  const pool = strongPool("B");
  const opts = { degenTargets: TARGETS, smartWalletBonus: 20, narrativeBonus: 10 };
  const bare = computeCandidateConfidence({ pool, sw: { in_pool: [] }, n: null }, opts);
  assert.equal(bare.score, Math.round(degenScore(pool, TARGETS) * 10) / 10);
  assert.equal(bare.hasNarrative, false);
});

test("blockers: PVP, pool memory, and invalid volatility disqualify auto-deploy", () => {
  const opts = { degenTargets: TARGETS };
  const pvp = computeCandidateConfidence({ pool: { ...strongPool("P"), is_pvp: true }, sw: { in_pool: [] }, n: null }, opts);
  assert.ok(pvp.blockers.some((b) => b.startsWith("PVP")));
  const mem = computeCandidateConfidence({ pool: strongPool("M"), sw: { in_pool: [] }, n: null, mem: "POOL MEMORY [...]: 2 past deploys" }, opts);
  assert.ok(mem.blockers.some((b) => b.startsWith("pool has deploy history")));
  const badVol = computeCandidateConfidence({ pool: { ...strongPool("V"), volatility: 0 }, sw: { in_pool: [] }, n: null }, opts);
  assert.ok(badVol.blockers.some((b) => b.startsWith("invalid volatility")));
});

test("missing candidate data scores zero with a blocker", () => {
  const conf = computeCandidateConfidence(null);
  assert.equal(conf.score, 0);
  assert.ok(conf.blockers.length > 0);
});

test("pickAutoDeployCandidate: skips blocked candidates even when they score higher", () => {
  const blocked = {
    pool: { ...strongPool("BLOCKED"), is_pvp: true },
    sw: { in_pool: [{ name: "kol" }, { name: "kol2" }] },
    n: { narrative: "story" },
  };
  const clean = { pool: strongPool("CLEAN"), sw: { in_pool: [] }, n: null };
  // minConfidence 0 → anything unblocked is eligible; blocked must never win
  const pick = pickAutoDeployCandidate([blocked, clean], { minConfidence: 0, degenTargets: TARGETS });
  assert.ok(pick, "should pick the clean candidate");
  assert.equal(pick.ctx.pool.name, "CLEAN");
});

test("pickAutoDeployCandidate: returns null when nothing clears the bar", () => {
  const clean = { pool: strongPool("CLEAN"), sw: { in_pool: [] }, n: null };
  assert.equal(pickAutoDeployCandidate([clean], { minConfidence: 1e9, degenTargets: TARGETS }), null);
  assert.equal(pickAutoDeployCandidate([], { minConfidence: 0 }), null);
  assert.equal(pickAutoDeployCandidate(null, { minConfidence: 0 }), null);
});

test("pickAutoDeployCandidate: highest score wins among eligible", () => {
  const low = { pool: strongPool("LOW"), sw: { in_pool: [] }, n: null };
  const high = { pool: strongPool("HIGH"), sw: { in_pool: [{ name: "kol" }] }, n: { narrative: "x" } };
  const pick = pickAutoDeployCandidate([low, high], { minConfidence: 0, degenTargets: TARGETS });
  assert.equal(pick.ctx.pool.name, "HIGH");
});
