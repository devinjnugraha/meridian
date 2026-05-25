/**
 * Tests for state-history enrichment output structure.
 * Run: node test/test-state-history.js
 *
 * Tests verify the enrichment function produces the correct history object
 * for three scenarios:
 * - Pool with recent loss history
 * - Pool with old win history
 * - Pool with no history
 */
import assert from "assert";

// ── Inline the enrichment logic (avoids importing state.js which requires logger + state.json) ──

function classifyOutcome(pnlPct) {
  if (pnlPct == null) return "unknown";
  if (pnlPct > 1) return "win";
  if (pnlPct < -1) return "loss";
  return "breakeven";
}

function countConsecutiveLosses(deploys) {
  let count = 0;
  for (let i = deploys.length - 1; i >= 0; i--) {
    if ((deploys[i].pnl_pct ?? 0) < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Pure version of enrichHistory that takes a positions map directly.
 */
function enrichHistoryFromPositions(poolAddress, positionsMap) {
  if (!positionsMap) return { history: { found: false } };

  const positions = Object.values(positionsMap);

  const matching = positions.filter((p) => p.closed && p.pool === poolAddress);

  if (matching.length === 0) {
    return { history: { found: false } };
  }

  const sorted = matching
    .filter((p) => p.closed_at)
    .sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));

  if (sorted.length === 0) {
    return { history: { found: false } };
  }

  const lastDeploy = sorted[0];
  const lastOutcome = classifyOutcome(lastDeploy.peak_pnl_pct);
  const minutesSinceClose = Math.floor(
    (Date.now() - new Date(lastDeploy.closed_at).getTime()) / 60000
  );

  const withPnl = sorted.filter((p) => p.peak_pnl_pct != null);
  const avgPnlPct = withPnl.length > 0
    ? Math.round((withPnl.reduce((s, p) => s + p.peak_pnl_pct, 0) / withPnl.length) * 100) / 100
    : null;
  const wins = withPnl.filter((p) => p.peak_pnl_pct > 1).length;
  const winRate = withPnl.length > 0
    ? Math.round((wins / withPnl.length) * 100)
    : null;

  const deploysForLossCount = sorted.slice().reverse().map((p) => ({ pnl_pct: p.peak_pnl_pct ?? 0 }));
  const consecutiveLosses = countConsecutiveLosses(deploysForLossCount);

  const lastSnapshot = lastDeploy.signal_snapshot;
  const closeNotes = (lastDeploy.notes || []).filter((n) => n.startsWith("Closed at"));
  const lastCloseReason = closeNotes.length > 0
    ? closeNotes[closeNotes.length - 1].replace(/^Closed at .+?: /, "")
    : null;

  return {
    history: {
      found: true,
      total_deploys: sorted.length,
      last_outcome: lastOutcome,
      last_close_reason: lastCloseReason,
      last_closed_at: lastDeploy.closed_at,
      minutes_since_last_close: minutesSinceClose,
      last_signal_snapshot: lastSnapshot
        ? {
            volume: lastSnapshot.volume ?? null,
            mcap: lastSnapshot.mcap ?? null,
            fee_tvl_ratio: lastSnapshot.fee_tvl_ratio ?? null,
            organic_score: lastSnapshot.organic_score ?? null,
            volatility: lastSnapshot.volatility ?? null,
            holder_count: lastSnapshot.holder_count ?? null,
          }
        : null,
      avg_pnl_pct: avgPnlPct,
      win_rate: winRate,
      consecutive_losses: consecutiveLosses,
    },
  };
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

console.log("enrichHistory\n");

// ── Test 1: Pool with history (loss, recent) ──────────────────────────

const LOSS_POOL = "PoolABC111";

const positionsWithLoss = {
  pos1: {
    position: "pos1",
    pool: LOSS_POOL,
    pool_name: "TOKEN-SOL",
    closed: true,
    closed_at: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 minutes ago
    peak_pnl_pct: -22.94,
    notes: [
      "Closed at 2026-05-25T01:14:45.836Z: Dumped far below range",
    ],
    signal_snapshot: {
      organic_score: 75,
      fee_tvl_ratio: 1.1123,
      volume: 7714,
      mcap: 450342,
      holder_count: 1486,
      volatility: 3.66,
    },
  },
  pos2: {
    position: "pos2",
    pool: LOSS_POOL,
    pool_name: "TOKEN-SOL",
    closed: true,
    closed_at: new Date(Date.now() - 180 * 60_000).toISOString(), // 3h ago
    peak_pnl_pct: -5.5,
    notes: [
      "Closed at 2026-05-25T00:00:00.000Z: Out of range for 30m",
    ],
    signal_snapshot: null,
  },
};

test("pool with recent loss: history.found = true", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.found, true);
});

test("pool with recent loss: total_deploys = 2", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.total_deploys, 2);
});

test("pool with recent loss: last_outcome = loss", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.last_outcome, "loss");
});

test("pool with recent loss: last_close_reason extracted from notes", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.last_close_reason, "Dumped far below range");
});

test("pool with recent loss: minutes_since_last_close ≈ 61", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.ok(
    Math.abs(history.minutes_since_last_close - 61) <= 1,
    `Expected ~61, got ${history.minutes_since_last_close}`
  );
});

test("pool with recent loss: last_signal_snapshot has expected fields", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.last_signal_snapshot.volume, 7714);
  assert.strictEqual(history.last_signal_snapshot.mcap, 450342);
  assert.strictEqual(history.last_signal_snapshot.fee_tvl_ratio, 1.1123);
  assert.strictEqual(history.last_signal_snapshot.organic_score, 75);
  assert.strictEqual(history.last_signal_snapshot.volatility, 3.66);
  assert.strictEqual(history.last_signal_snapshot.holder_count, 1486);
});

test("pool with recent loss: avg_pnl_pct computed correctly", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  // (-22.94 + -5.5) / 2 = -14.22
  assert.strictEqual(history.avg_pnl_pct, -14.22);
});

test("pool with recent loss: win_rate = 0 (both losses)", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.win_rate, 0);
});

test("pool with recent loss: consecutive_losses = 2", () => {
  const { history } = enrichHistoryFromPositions(LOSS_POOL, positionsWithLoss);
  assert.strictEqual(history.consecutive_losses, 2);
});

// ── Test 2: Pool with history (win, old) ──────────────────────────────

const WIN_POOL = "PoolDEF222";

const positionsWithWin = {
  pos3: {
    position: "pos3",
    pool: WIN_POOL,
    pool_name: "WINNER-SOL",
    closed: true,
    closed_at: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(), // 7 days ago
    peak_pnl_pct: 10.27,
    notes: [
      "Closed at 2026-05-18T00:00:00.000Z: Take profit at 10%",
    ],
    signal_snapshot: {
      organic_score: 90,
      fee_tvl_ratio: 0.5,
      volume: 50000,
      mcap: 800000,
      holder_count: 3000,
      volatility: 2.5,
    },
  },
};

test("pool with old win: history.found = true", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.found, true);
});

test("pool with old win: total_deploys = 1", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.total_deploys, 1);
});

test("pool with old win: last_outcome = win", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.last_outcome, "win");
});

test("pool with old win: minutes_since_last_close ≈ 10080 (7 days)", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  const expected = 7 * 24 * 60; // 10080
  assert.ok(
    Math.abs(history.minutes_since_last_close - expected) <= 1,
    `Expected ~${expected}, got ${history.minutes_since_last_close}`
  );
});

test("pool with old win: avg_pnl_pct = 10.27", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.avg_pnl_pct, 10.27);
});

test("pool with old win: win_rate = 100", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.win_rate, 100);
});

test("pool with old win: consecutive_losses = 0", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.consecutive_losses, 0);
});

test("pool with old win: last_signal_snapshot preserved", () => {
  const { history } = enrichHistoryFromPositions(WIN_POOL, positionsWithWin);
  assert.strictEqual(history.last_signal_snapshot.volume, 50000);
  assert.strictEqual(history.last_signal_snapshot.mcap, 800000);
});

// ── Test 3: Pool with no history ──────────────────────────────────────

const UNKNOWN_POOL = "PoolXYZ999";

test("unknown pool: history.found = false", () => {
  const { history } = enrichHistoryFromPositions(UNKNOWN_POOL, positionsWithLoss);
  assert.strictEqual(history.found, false);
});

test("unknown pool: only has found field", () => {
  const { history } = enrichHistoryFromPositions(UNKNOWN_POOL, positionsWithLoss);
  assert.strictEqual(Object.keys(history).length, 1);
  assert.ok(history.found === false);
});

test("null positions map: returns found=false", () => {
  const { history } = enrichHistoryFromPositions(UNKNOWN_POOL, null);
  assert.strictEqual(history.found, false);
});

// ── Test 4: Mixed history (win then loss) ─────────────────────────────

const MIXED_POOL = "PoolMIX333";

const positionsMixed = {
  pos4a: {
    position: "pos4a",
    pool: MIXED_POOL,
    closed: true,
    closed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    peak_pnl_pct: -3.5,
    notes: ["Closed at 2026-05-25T01:00:00.000Z: Low yield exit"],
    signal_snapshot: { volume: 1000, mcap: 500000, fee_tvl_ratio: 0.1, organic_score: 70, volatility: 1.5, holder_count: 1000 },
  },
  pos4b: {
    position: "pos4b",
    pool: MIXED_POOL,
    closed: true,
    closed_at: new Date(Date.now() - 500 * 60_000).toISOString(),
    peak_pnl_pct: 5.0,
    notes: ["Closed at 2026-05-24T01:00:00.000Z: Take profit"],
    signal_snapshot: null,
  },
};

test("mixed history: total_deploys = 2", () => {
  const { history } = enrichHistoryFromPositions(MIXED_POOL, positionsMixed);
  assert.strictEqual(history.total_deploys, 2);
});

test("mixed history: last_outcome = loss (most recent)", () => {
  const { history } = enrichHistoryFromPositions(MIXED_POOL, positionsMixed);
  assert.strictEqual(history.last_outcome, "loss");
});

test("mixed history: consecutive_losses = 1 (only last one)", () => {
  const { history } = enrichHistoryFromPositions(MIXED_POOL, positionsMixed);
  assert.strictEqual(history.consecutive_losses, 1);
});

test("mixed history: win_rate = 50", () => {
  const { history } = enrichHistoryFromPositions(MIXED_POOL, positionsMixed);
  assert.strictEqual(history.win_rate, 50);
});

test("mixed history: avg_pnl_pct = 0.75", () => {
  const { history } = enrichHistoryFromPositions(MIXED_POOL, positionsMixed);
  // (-3.5 + 5.0) / 2 = 0.75
  assert.strictEqual(history.avg_pnl_pct, 0.75);
});

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
