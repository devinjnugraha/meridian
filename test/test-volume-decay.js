/**
 * Tests for computeVolumeDecayPct (pure function, no deps).
 * Run: node test/test-volume-decay.js
 */
import assert from "assert";

// Inline the pure function to avoid importing state.js (which requires logger + state.json)
function computeVolumeDecayPct(entryVolume, currentVolume) {
    if (entryVolume == null || entryVolume <= 0) return null;
    const current = Math.max(0, currentVolume ?? 0);
    const decay = ((entryVolume - current) / entryVolume) * 100;
    return Math.max(0, decay);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}: ${e.message}`);
    }
}

console.log("computeVolumeDecayPct\n");

// ── Basic calculations ──
test("50% decay: entry=1000, current=500", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, 500), 50);
});

test("70% decay: entry=1000, current=300", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, 300), 70);
});

test("0% decay: entry=1000, current=1000", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, 1000), 0);
});

test("0% decay when volume grew: entry=1000, current=2000", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, 2000), 0);
});

test("100% decay: entry=1000, current=0", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, 0), 100);
});

// ── Edge cases ──
test("returns null when entryVolume is null", () => {
    assert.strictEqual(computeVolumeDecayPct(null, 500), null);
});

test("returns null when entryVolume is undefined", () => {
    assert.strictEqual(computeVolumeDecayPct(undefined, 500), null);
});

test("returns null when entryVolume is 0", () => {
    assert.strictEqual(computeVolumeDecayPct(0, 500), null);
});

test("returns null when entryVolume is negative", () => {
    assert.strictEqual(computeVolumeDecayPct(-100, 50), null);
});

test("treats negative currentVolume as 0 (100% decay)", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, -100), 100);
});

test("treats null currentVolume as 0 (100% decay)", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, null), 100);
});

test("treats undefined currentVolume as 0 (100% decay)", () => {
    assert.strictEqual(computeVolumeDecayPct(1000, undefined), 100);
});

// ── Decimal precision ──
test("partial decay: entry=1000, current=753 → 24.7%", () => {
    const result = computeVolumeDecayPct(1000, 753);
    assert.ok(Math.abs(result - 24.7) < 0.01, `expected ~24.7, got ${result}`);
});

test("small entry volume: entry=1, current=0.3 → 70%", () => {
    const result = computeVolumeDecayPct(1, 0.3);
    assert.ok(Math.abs(result - 70) < 0.01, `expected ~70, got ${result}`);
});

// ── Realistic scenarios ──
test("entry=50000, current=12000 → 76% decay", () => {
    const result = computeVolumeDecayPct(50000, 12000);
    assert.ok(Math.abs(result - 76) < 0.01, `expected ~76, got ${result}`);
});

test("entry=50000, current=48000 → 4% decay (not enough to trigger 70%)", () => {
    const result = computeVolumeDecayPct(50000, 48000);
    assert.ok(Math.abs(result - 4) < 0.01, `expected ~4, got ${result}`);
});

test("entry=50000, current=15000 → exactly 70% decay", () => {
    const result = computeVolumeDecayPct(50000, 15000);
    assert.strictEqual(result, 70);
});

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
