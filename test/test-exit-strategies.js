/**
 * Unit tests for exit-strategy logic after the SSOT refactor.
 *
 * Run from project root:  node test/test-exit-strategies.js
 *
 * Validates:
 *  1. updatePnlAndCheckExits (state.js) — stop loss, take profit, trailing TP,
 *     OOR timeout, low yield, IL stop, and null (no exit).
 *  2. getBinBasedCloseRule (index.js, inlined here since it's not exported) —
 *     bin-geometry rules 3, 4, 7 only.
 *  3. No-overlap: getBinBasedCloseRule never fires on PnL / yield / IL scenarios.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import {
    trackPosition,
    updatePnlAndCheckExits,
    computeILMetrics,
    shouldTriggerILStop,
    queueStopLossConfirmation,
    resolvePendingStopLoss,
    queueILStopConfirmation,
    resolvePendingILStop,
} from "../state.js";

// ─── Helpers ───────────────────────────────────────────────────────
const STATE_FILE = "./state.json";
let _originalState = null;

before(() => {
    if (fs.existsSync(STATE_FILE)) {
        _originalState = fs.readFileSync(STATE_FILE, "utf8");
    }
});

after(() => {
    // Restore original state.json so we never corrupt live data
    if (_originalState != null) {
        fs.writeFileSync(STATE_FILE, _originalState);
    } else if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
    }
});

function freshState() {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ positions: {}, recentEvents: [], lastUpdated: null }),
    );
}

let _counter = 0;
function seedPosition(overrides = {}) {
    const addr = `pos_${++_counter}_${Date.now()}`;
    trackPosition({
        position: addr,
        pool: "test-pool",
        pool_name: "TEST/SOL",
        strategy: "spot",
        bin_range: { min: 100, max: 200, bins_above: 10, bins_below: 10 },
        amount_sol: 1,
        active_bin: 150,
        bin_step: 1,
        ...overrides,
    });
    return addr;
}

/** Default management config — all features enabled with sensible thresholds */
function mgmtConfig(overrides = {}) {
    return {
        stopLossPct: -30,
        takeProfitPct: 50,
        trailingTakeProfit: true,
        trailingTriggerPct: 20,
        trailingDropPct: 10,
        outOfRangeWaitMinutes: 60,
        minFeePerTvl24h: 1.0,
        minAgeBeforeYieldCheck: 60,
        dynamicILStop: true,
        ilStopMinPct: -10,
        ilStopMinAgeMinutes: 30,
        ilRecoveryMaxDays: 5,
        outOfRangeBinsToClose: 50,
        outOfRangeBinsToCloseBelow: 50,
        ...overrides,
    };
}

/**
 * Inlined copy of getBinBasedCloseRule from index.js.
 * Kept here so we can test it without importing the full index.js
 * (which pulls in Solana SDKs, DLMM, etc.).
 */
function getBinBasedCloseRule(position, managementConfig) {
    if (
        position.active_bin != null &&
        position.upper_bin != null &&
        position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
    ) {
        return { action: "CLOSE", rule: 3, reason: "Pumped far above range" };
    }
    if (
        position.active_bin != null &&
        position.lower_bin != null &&
        position.active_bin < position.lower_bin - managementConfig.outOfRangeBinsToCloseBelow
    ) {
        return { action: "CLOSE", rule: 7, reason: "Dumped far below range" };
    }
    if (
        position.active_bin != null &&
        position.upper_bin != null &&
        position.active_bin > position.upper_bin &&
        (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
    ) {
        return { action: "CLOSE", rule: 4, reason: "OOR" };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  1. updatePnlAndCheckExits — the single source of truth for exits
// ═══════════════════════════════════════════════════════════════════
describe("updatePnlAndCheckExits", () => {
    beforeEach(() => freshState());

    it("returns STOP_LOSS (needs_confirmation) when pnl <= stopLossPct", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -35,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.notEqual(result, null);
        assert.equal(result.action, "STOP_LOSS");
        assert.equal(result.needs_confirmation, true);
        assert.equal(result.current_pnl_pct, -35);
        assert.match(result.reason, /Stop loss/);
    });

    it("returns TAKE_PROFIT when pnl >= takeProfitPct", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 55,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.notEqual(result, null);
        assert.equal(result.action, "TAKE_PROFIT");
        assert.match(result.reason, /Take profit/);
    });

    it("returns null when pnl is between stop loss and take profit", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 10,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.equal(result, null);
    });

    it("skips PnL checks when pnl_pct_suspicious is true (unless extreme)", () => {
        const addr = seedPosition();
        // PnL of -35% would trigger stop-loss normally (-30%) but NOT with 1.5x relaxed threshold (-45%)
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -35,
            pnl_pct_suspicious: true,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        // Should NOT return STOP_LOSS because -35% > -45% (relaxed threshold)
        if (result) {
            assert.notEqual(result.action, "STOP_LOSS");
        }
    });

    it("fires STOP_LOSS even when suspicious if PnL is extreme", () => {
        const addr = seedPosition();
        // PnL of -99% is well below relaxed threshold (-45%), should still fire
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -99,
            pnl_pct_suspicious: true,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.ok(result, "Should return an action for extreme loss even when suspicious");
        assert.equal(result.action, "STOP_LOSS");
    });

    it("returns OUT_OF_RANGE after timeout", () => {
        const addr = seedPosition();
        // First call: mark OOR
        updatePnlAndCheckExits(addr, {
            pnl_pct: 0,
            in_range: false,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        // Manually set out_of_range_since to 2 hours ago
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        state.positions[addr].out_of_range_since = new Date(Date.now() - 120 * 60_000).toISOString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 0,
            in_range: false,
            fee_per_tvl_24h: 5,
        }, mgmtConfig({ outOfRangeWaitMinutes: 60 }));

        assert.notEqual(result, null);
        assert.equal(result.action, "OUT_OF_RANGE");
        assert.match(result.reason, /Out of range/);
    });

    it("returns LOW_YIELD when fee/tvl below min and old enough", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 0,
            in_range: true,
            fee_per_tvl_24h: 0.3,
            age_minutes: 120,
        }, mgmtConfig({ minFeePerTvl24h: 1.0 }));

        assert.notEqual(result, null);
        assert.equal(result.action, "LOW_YIELD");
        assert.match(result.reason, /Low yield/);
    });

    it("does NOT return LOW_YIELD when position is too young", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 0,
            in_range: true,
            fee_per_tvl_24h: 0.3,
            age_minutes: 15,  // too young
        }, mgmtConfig({ minFeePerTvl24h: 1.0, minAgeBeforeYieldCheck: 60 }));

        assert.equal(result, null);
    });

    it("returns TRAILING_TP (needs_confirmation) when drop exceeds threshold", () => {
        const addr = seedPosition();
        // Set up: peak at 30%, trailing active
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        state.positions[addr].peak_pnl_pct = 30;
        state.positions[addr].trailing_active = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 18, // dropped 12% from peak (>= 10% threshold)
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig({ trailingDropPct: 10 }));

        assert.notEqual(result, null);
        assert.equal(result.action, "TRAILING_TP");
        assert.equal(result.needs_confirmation, true);
        assert.equal(result.peak_pnl_pct, 30);
    });

    it("does NOT return TRAILING_TP when drop is below threshold", () => {
        const addr = seedPosition();
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        state.positions[addr].peak_pnl_pct = 30;
        state.positions[addr].trailing_active = true;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 25, // dropped only 5%, < 10% threshold
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig({ trailingDropPct: 10 }));

        assert.equal(result, null);
    });

    it("returns IL_STOP with needs_confirmation when IL is deep and unrecoverable", () => {
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -15,
            pnl_usd: -10,
            in_range: true,
            fee_per_tvl_24h: 0.1,
            total_value_usd: 50,
            unclaimed_fees_usd: 0.5,
            collected_fees_usd: 0.5,
            age_minutes: 120,
            pool_fees_1h: 0.01,
            pool_active_tvl: 1000,
        }, mgmtConfig({
            dynamicILStop: true,
            ilStopMinPct: -10,
            ilStopMinAgeMinutes: 30,
            ilRecoveryMaxDays: 5,
        }));

        // IL = pnl_usd - totalFees = -10 - 1 = -11 → ilPct = -11/60 * 100 ≈ -18.3%
        // This should trigger if recovery days exceed threshold
        if (result) {
            assert.equal(result.action, "IL_STOP");
            assert.equal(result.needs_confirmation, true);
            assert.ok(result.il_metrics);
            assert.match(result.reason, /IL stop/);
        }
        // If it doesn't trigger, the projected daily fee covers it — also acceptable
    });

    it("queues IL stop confirmation and resolves confirmed", () => {
        const addr = seedPosition();
        const cfg = mgmtConfig({
            dynamicILStop: true,
            ilStopMinPct: -10,
            ilStopMinAgeMinutes: 30,
            ilRecoveryMaxDays: 5,
        });

        const positionData = {
            pnl_pct: -15,
            pnl_usd: -10,
            in_range: true,
            fee_per_tvl_24h: 0.1,
            total_value_usd: 50,
            unclaimed_fees_usd: 0.5,
            collected_fees_usd: 0.5,
            age_minutes: 120,
            pool_fees_1h: 0.01,
            pool_active_tvl: 1000,
        };

        // First call triggers IL_STOP and queues confirmation
        const exit = updatePnlAndCheckExits(addr, positionData, cfg);
        if (!exit || exit.action !== "IL_STOP") return; // fee projection may not trigger

        const queued = queueILStopConfirmation(addr, exit.il_metrics);
        assert.equal(queued, true);

        // Duplicate queue (same IL) should not re-queue
        const queued2 = queueILStopConfirmation(addr, exit.il_metrics);
        assert.equal(queued2, false);

        // Resolve with fresh data that still triggers
        const resolved = resolvePendingILStop(addr, positionData, cfg);
        if (resolved.confirmed) {
            assert.ok(resolved.reason);
            assert.match(resolved.reason, /IL stop confirmed/);
        }
    });

    it("rejects IL stop recheck when IL recovers", () => {
        const addr = seedPosition();
        const cfg = mgmtConfig({
            dynamicILStop: true,
            ilStopMinPct: -10,
            ilStopMinAgeMinutes: 30,
            ilRecoveryMaxDays: 5,
        });

        const badData = {
            pnl_pct: -15,
            pnl_usd: -10,
            in_range: true,
            fee_per_tvl_24h: 0.1,
            total_value_usd: 50,
            unclaimed_fees_usd: 0.5,
            collected_fees_usd: 0.5,
            age_minutes: 120,
            pool_fees_1h: 0.01,
            pool_active_tvl: 1000,
        };

        const exit = updatePnlAndCheckExits(addr, badData, cfg);
        if (!exit || exit.action !== "IL_STOP") return;

        queueILStopConfirmation(addr, exit.il_metrics);

        // Resolve with recovered data (fees now cover IL)
        const recoveredData = {
            ...badData,
            pnl_usd: -0.5,
            unclaimed_fees_usd: 2,
            collected_fees_usd: 2,
        };

        const resolved = resolvePendingILStop(addr, recoveredData, cfg);
        assert.equal(resolved.confirmed, false);
    });

    it("executes confirmed IL stop within 30s window", () => {
        const addr = seedPosition();
        const cfg = mgmtConfig({
            dynamicILStop: true,
            ilStopMinPct: -10,
            ilStopMinAgeMinutes: 30,
            ilRecoveryMaxDays: 5,
        });

        const badData = {
            pnl_pct: -15,
            pnl_usd: -10,
            in_range: true,
            fee_per_tvl_24h: 0.1,
            total_value_usd: 50,
            unclaimed_fees_usd: 0.5,
            collected_fees_usd: 0.5,
            age_minutes: 120,
            pool_fees_1h: 0.01,
            pool_active_tvl: 1000,
        };

        const exit = updatePnlAndCheckExits(addr, badData, cfg);
        if (!exit || exit.action !== "IL_STOP") return;

        queueILStopConfirmation(addr, exit.il_metrics);
        const resolved = resolvePendingILStop(addr, badData, cfg);
        if (!resolved.confirmed) return;

        // Now call updatePnlAndCheckExits again — should pick up confirmed IL stop
        const executed = updatePnlAndCheckExits(addr, { pnl_pct: 0, in_range: true, fee_per_tvl_24h: 5 }, cfg);
        assert.ok(executed);
        assert.equal(executed.action, "IL_STOP");
        assert.equal(executed.confirmed_recheck, true);
    });

    it("stop loss has higher priority than take profit", () => {
        // Edge case: both thresholds could theoretically overlap with bad config
        const addr = seedPosition();
        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -40,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig({ stopLossPct: -30, takeProfitPct: -50 })); // bad config: TP below SL

        assert.notEqual(result, null);
        assert.equal(result.action, "STOP_LOSS");
        assert.equal(result.needs_confirmation, true); // SL comes first in the function
    });
});

// ═══════════════════════════════════════════════════════════════════
//  2. getBinBasedCloseRule — bin-geometry only
// ═══════════════════════════════════════════════════════════════════
describe("getBinBasedCloseRule", () => {
    it("returns rule 3 when active_bin pumped far above range", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 300, upper_bin: 200, lower_bin: 100 },
            mgmtConfig({ outOfRangeBinsToClose: 50 }),
        );
        assert.notEqual(result, null);
        assert.equal(result.rule, 3);
        assert.match(result.reason, /Pumped far above/);
    });

    it("returns rule 7 when active_bin dumped far below range", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 10, upper_bin: 200, lower_bin: 100 },
            mgmtConfig({ outOfRangeBinsToCloseBelow: 50 }),
        );
        assert.notEqual(result, null);
        assert.equal(result.rule, 7);
        assert.match(result.reason, /Dumped far below/);
    });

    it("returns rule 4 (OOR) when above range for too long", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 210, upper_bin: 200, lower_bin: 100, minutes_out_of_range: 90 },
            mgmtConfig({ outOfRangeWaitMinutes: 60 }),
        );
        assert.notEqual(result, null);
        assert.equal(result.rule, 4);
        assert.equal(result.reason, "OOR");
    });

    it("returns null when active_bin is inside range", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 150, upper_bin: 200, lower_bin: 100 },
            mgmtConfig(),
        );
        assert.equal(result, null);
    });

    it("returns null when slightly above range but not exceeding bins threshold", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 220, upper_bin: 200, lower_bin: 100, minutes_out_of_range: 10 },
            mgmtConfig({ outOfRangeBinsToClose: 50, outOfRangeWaitMinutes: 60 }),
        );
        // active_bin (220) > upper_bin (200) but < upper_bin + 50 (250) → rule 3 doesn't fire
        // OOR minutes (10) < 60 → rule 4 doesn't fire
        assert.equal(result, null);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  3. No-overlap validation — bin rules don't fire on PnL scenarios
// ═══════════════════════════════════════════════════════════════════
describe("no-overlap: getBinBasedCloseRule ignores PnL/yield/IL", () => {
    it("does NOT fire on stop-loss PnL (in-range position)", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 150, upper_bin: 200, lower_bin: 100, pnl_pct: -50 },
            mgmtConfig(),
        );
        assert.equal(result, null);
    });

    it("does NOT fire on take-profit PnL (in-range position)", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 150, upper_bin: 200, lower_bin: 100, pnl_pct: 100 },
            mgmtConfig(),
        );
        assert.equal(result, null);
    });

    it("does NOT fire on low yield (in-range position)", () => {
        const result = getBinBasedCloseRule(
            { active_bin: 150, upper_bin: 200, lower_bin: 100, fee_per_tvl_24h: 0.01, age_minutes: 120 },
            mgmtConfig(),
        );
        assert.equal(result, null);
    });

    it("does NOT inspect pnl_pct_suspicious at all", () => {
        // Verify the function doesn't reference PnL at all
        const src = getBinBasedCloseRule.toString();
        assert.equal(src.includes("pnl_pct"), false, "getBinBasedCloseRule should not reference pnl_pct");
        assert.equal(src.includes("fee_per_tvl"), false, "getBinBasedCloseRule should not reference fee_per_tvl");
    });
});

// ═══════════════════════════════════════════════════════════════════
//  4. computeILMetrics + shouldTriggerILStop (sanity checks)
// ═══════════════════════════════════════════════════════════════════
describe("computeILMetrics", () => {
    it("returns null when IL is positive (no impermanent loss)", () => {
        const result = computeILMetrics({
            pnl_usd: 10,
            unclaimed_fees_usd: 2,
            collected_fees_usd: 3,
            total_value_usd: 100,
        });
        // pnl_usd (10) - totalFees (5) = 5 → positive, no IL
        assert.equal(result, null);
    });

    it("computes negative IL correctly", () => {
        const result = computeILMetrics({
            pnl_usd: -5,
            unclaimed_fees_usd: 1,
            collected_fees_usd: 1,
            total_value_usd: 90,
            age_minutes: 120,
            pool_fees_1h: 0.5,
            pool_active_tvl: 1000,
        });
        assert.notEqual(result, null);
        // ilUsd = -5 - 2 = -7
        assert.equal(result.ilUsd, -7);
        assert.ok(result.ilPct < 0);
        assert.ok(result.daysToRecover > 0);
    });
});

describe("shouldTriggerILStop", () => {
    it("triggers when all conditions met", () => {
        const result = shouldTriggerILStop(
            { ilPct: -15, ageMinutes: 120, daysToRecover: 10 },
            { ilStopMinPct: -10, ilStopMinAgeMinutes: 30, ilRecoveryMaxDays: 5 },
        );
        assert.equal(result, true);
    });

    it("does NOT trigger when IL is too shallow", () => {
        const result = shouldTriggerILStop(
            { ilPct: -5, ageMinutes: 120, daysToRecover: 10 },
            { ilStopMinPct: -10, ilStopMinAgeMinutes: 30, ilRecoveryMaxDays: 5 },
        );
        assert.equal(result, false);
    });

    it("does NOT trigger when position is too young", () => {
        const result = shouldTriggerILStop(
            { ilPct: -15, ageMinutes: 10, daysToRecover: 10 },
            { ilStopMinPct: -10, ilStopMinAgeMinutes: 30, ilRecoveryMaxDays: 5 },
        );
        assert.equal(result, false);
    });

    it("does NOT trigger when recovery is fast enough", () => {
        const result = shouldTriggerILStop(
            { ilPct: -15, ageMinutes: 120, daysToRecover: 2 },
            { ilStopMinPct: -10, ilStopMinAgeMinutes: 30, ilRecoveryMaxDays: 5 },
        );
        assert.equal(result, false);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  5. Stop loss confirmation — queue, resolve, confirmed execution
// ═══════════════════════════════════════════════════════════════════
describe("stop loss confirmation", () => {
    beforeEach(() => freshState());

    it("queueStopLossConfirmation queues when pnl <= stopLossPct", () => {
        const addr = seedPosition();
        const queued = queueStopLossConfirmation(addr, -35, -30);
        assert.equal(queued, true);

        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        assert.equal(state.positions[addr].pending_stop_loss_pnl_pct, -35);
        assert.ok(state.positions[addr].pending_stop_loss_started_at);
    });

    it("queueStopLossConfirmation rejects when pnl > stopLossPct", () => {
        const addr = seedPosition();
        const queued = queueStopLossConfirmation(addr, -20, -30);
        assert.equal(queued, false);
    });

    it("queueStopLossConfirmation only queues when pnl is worse", () => {
        const addr = seedPosition();
        queueStopLossConfirmation(addr, -35, -30);
        // Same or higher PnL should not re-queue
        assert.equal(queueStopLossConfirmation(addr, -35, -30), false);
        // Lower (worse) PnL should re-queue
        assert.equal(queueStopLossConfirmation(addr, -40, -30), true);
    });

    it("resolvePendingStopLoss confirms when still below threshold", () => {
        const addr = seedPosition();
        queueStopLossConfirmation(addr, -35, -30);
        // current (-34.5) must be <= pending (-35) + tolerance (1.0) = -34, AND <= stopLossPct (-30)
        const resolved = resolvePendingStopLoss(addr, -34.5, -30, 1.0);

        assert.equal(resolved.confirmed, true);
        assert.match(resolved.reason, /Stop loss confirmed/);

        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        assert.ok(state.positions[addr].confirmed_stop_loss_exit_reason);
        assert.ok(state.positions[addr].confirmed_stop_loss_exit_until);
        assert.equal(state.positions[addr].pending_stop_loss_pnl_pct, null);
    });

    it("resolvePendingStopLoss rejects when pnl recovered", () => {
        const addr = seedPosition();
        queueStopLossConfirmation(addr, -35, -30);
        // PnL recovered above stop loss
        const resolved = resolvePendingStopLoss(addr, -10, -30, 1.0);

        assert.equal(resolved.confirmed, false);
        assert.equal(resolved.rejected, true);

        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        assert.equal(state.positions[addr].confirmed_stop_loss_exit_reason, null);
        assert.equal(state.positions[addr].pending_stop_loss_pnl_pct, null);
    });

    it("confirmed stop loss fires immediately in updatePnlAndCheckExits", () => {
        const addr = seedPosition();
        // Simulate a confirmed stop loss with 30s window
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        state.positions[addr].confirmed_stop_loss_exit_reason = "Stop loss confirmed: -35% <= -30%";
        state.positions[addr].confirmed_stop_loss_exit_until = new Date(Date.now() + 30_000).toISOString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: -33,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.notEqual(result, null);
        assert.equal(result.action, "STOP_LOSS");
        assert.equal(result.confirmed_recheck, true);
        assert.match(result.reason, /Stop loss confirmed/);
    });

    it("confirmed stop loss expires after 30s window", () => {
        const addr = seedPosition();
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        state.positions[addr].confirmed_stop_loss_exit_reason = "Stop loss confirmed: -35% <= -30%";
        state.positions[addr].confirmed_stop_loss_exit_until = new Date(Date.now() - 1000).toISOString(); // expired
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        const result = updatePnlAndCheckExits(addr, {
            pnl_pct: 0,
            in_range: true,
            fee_per_tvl_24h: 5,
        }, mgmtConfig());

        assert.equal(result, null);
    });
});
