/**
 * Tests for computeFeeRateDecay — fee rate velocity decay exit trigger.
 *
 * Run: node test/test-fee-rate-decay.js
 *
 * Tests the pure decay calculation function in isolation.
 * No state.json, no config, no on-chain calls needed.
 */

import { computeFeeRateDecay } from "../state.js";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${msg}`);
    }
}

function assertEq(actual, expected, msg) {
    const ok = Math.abs(actual - expected) < 0.001;
    if (ok) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${msg} — expected ${expected}, got ${actual}`);
    }
}

// ─── computeFeeRateDecay tests ─────────────────────────────────

console.log("\ncomputeFeeRateDecay\n");

// 1. Returns null when poolFees1h is null
{
    const result = computeFeeRateDecay(null, { peak_fee_rate: 0.5 });
    assert(result === null, "returns null when poolFees1h is null");
}

// 2. Returns null when trackedPos is null
{
    const result = computeFeeRateDecay(60, null);
    assert(result === null, "returns null when trackedPos is null");
}

// 3. Returns null when peak_fee_rate is zero or missing
{
    assert(computeFeeRateDecay(60, { peak_fee_rate: 0 }) === null, "returns null when peak_fee_rate is 0");
    assert(computeFeeRateDecay(60, { peak_fee_rate: null }) === null, "returns null when peak_fee_rate is null");
    assert(computeFeeRateDecay(60, {}) === null, "returns null when peak_fee_rate is missing");
}

// 4. Basic decay calculation: entry = peak = 1.0 USD/min (60 USD/h pool fees), current = 30 USD/h
{
    const result = computeFeeRateDecay(30, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assert(result !== null, "returns result for valid input");
    assertEq(result.entryFeeRate, 1.0, "entry fee rate is 1.0");
    assertEq(result.peakFeeRate, 1.0, "peak fee rate is 1.0");
    assertEq(result.currentFeeRate, 0.5, "current fee rate is 0.5 (30/60)");
    assertEq(result.decayPct, 50.0, "decay is 50%");
}

// 5. No decay (current equals peak)
{
    const result = computeFeeRateDecay(60, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assert(result !== null, "returns result");
    assertEq(result.decayPct, 0.0, "decay is 0% when current equals peak");
}

// 6. Full decay (current fee rate is 0)
{
    const result = computeFeeRateDecay(0, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assert(result !== null, "returns result");
    assertEq(result.decayPct, 100.0, "decay is 100% when current is 0");
}

// 7. Decay when peak was updated higher than entry
{
    // Entry was 1.0 USD/min (60 USD/h), but peak rose to 2.0 (120 USD/h)
    // Current is 30 USD/h = 0.5 USD/min
    // Decay = (2.0 - 0.5) / 2.0 * 100 = 75%
    const result = computeFeeRateDecay(30, { entry_fee_rate: 1.0, peak_fee_rate: 2.0 });
    assertEq(result.entryFeeRate, 1.0, "entry preserved");
    assertEq(result.peakFeeRate, 2.0, "peak is 2.0");
    assertEq(result.currentFeeRate, 0.5, "current is 0.5");
    assertEq(result.decayPct, 75.0, "decay is 75% from peak");
}

// 8. Current higher than peak — negative decay clamped to 0
{
    const result = computeFeeRateDecay(120, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assert(result !== null, "returns result");
    assertEq(result.currentFeeRate, 2.0, "current is 2.0 USD/min");
    assertEq(result.decayPct, 0.0, "decay clamped to 0% when current > peak");
}

// 9. Small decay below threshold (should not trigger at 60%)
{
    // peak = 1.0, current = 50 USD/h → 0.833 USD/min → decay = 16.7%
    const result = computeFeeRateDecay(50, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assertEq(result.decayPct, 16.667, "decay ~16.7% for moderate drop");
}

// 10. Decay exactly at 60% threshold
{
    // peak = 1.0, current = 24 USD/h → 0.4 USD/min → decay = 60%
    const result = computeFeeRateDecay(24, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assertEq(result.decayPct, 60.0, "decay exactly 60%");
}

// 11. Decay beyond 60% threshold
{
    // peak = 1.0, current = 12 USD/h → 0.2 USD/min → decay = 80%
    const result = computeFeeRateDecay(12, { entry_fee_rate: 1.0, peak_fee_rate: 1.0 });
    assertEq(result.decayPct, 80.0, "decay is 80%");
}

// 12. Uses entry_fee_rate fallback when missing (treats peak as entry)
{
    const result = computeFeeRateDecay(30, { peak_fee_rate: 1.0 });
    assert(result !== null, "returns result without entry_fee_rate");
    assertEq(result.entryFeeRate, 1.0, "entry falls back to peak");
}

// 13. Negative poolFees1h returns null
{
    const result = computeFeeRateDecay(-10, { peak_fee_rate: 1.0 });
    assert(result === null, "returns null for negative poolFees1h");
}

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
