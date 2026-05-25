/**
 * State history enrichment — looks up prior deploy history from state.json
 * and computes a structured history object for each candidate pool.
 *
 * Used during screening to give the LLM visibility into prior outcomes
 * so it can detect dump-rebound patterns and avoid re-entering bad pools.
 */

import fs from "fs";
import { log } from "../logger.js";

const STATE_FILE = "./state.json";

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_history", `Failed to read state.json: ${err.message}`);
    return null;
  }
}

/**
 * Classify a single deploy as win / loss / breakeven based on pnl_pct.
 */
function classifyOutcome(pnlPct) {
  if (pnlPct == null) return "unknown";
  if (pnlPct > 1) return "win";
  if (pnlPct < -1) return "loss";
  return "breakeven";
}

/**
 * Count consecutive losses from the end of a sorted deploys array.
 */
function countConsecutiveLosses(deploys) {
  let count = 0;
  for (let i = deploys.length - 1; i >= 0; i--) {
    const pnl = deploys[i].pnl_pct ?? 0;
    if (pnl < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Build a history enrichment object for a candidate pool.
 *
 * @param {string} poolAddress - Pool address to look up
 * @param {string} baseMint - Base token mint to look up (fallback matching)
 * @returns {object} History object to attach to candidate data
 */
export function enrichHistory(poolAddress, baseMint) {
  const state = loadState();

  if (!state || !state.positions) {
    log("state_history", `State unavailable — returning history.found=false for ${poolAddress?.slice(0, 8)}`);
    return { history: { found: false } };
  }

  const positions = Object.values(state.positions);

  // Find all closed positions matching this pool address or base mint
  const matching = positions.filter((p) => {
    if (!p.closed) return false;
    if (p.pool === poolAddress) return true;
    // Fallback: match by base mint if pool address differs (e.g. migrated pool)
    // But only match base mint if the pool doesn't match exactly
    return false;
  });

  // Also match by base token mint across different pools
  const mintMatching = baseMint
    ? positions.filter((p) => p.closed && p.pool !== poolAddress)
    : [];

  // Combine: exact pool matches first, then mint-only matches
  const allMatching = [...matching];

  // Add mint-only matches that aren't already in the pool match set
  if (baseMint) {
    const matchedPools = new Set(matching.map((p) => p.position));
    for (const p of positions) {
      if (p.closed && !matchedPools.has(p.position)) {
        // We need to check if this position was for the same base token.
        // state.json doesn't store base_mint directly on the position entry,
        // but pool-memory.json does. For now, match only by pool address.
        // Mint matching across pools is handled by pool-memory.js cooldowns.
      }
    }
  }

  if (allMatching.length === 0) {
    log("state_history", `No history for pool ${poolAddress?.slice(0, 8)} — returning history.found=false`);
    return { history: { found: false } };
  }

  // Sort by closed_at descending to get the most recent first
  const sorted = allMatching
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

  // Compute aggregate stats
  const withPnl = sorted.filter((p) => p.peak_pnl_pct != null);
  const avgPnlPct = withPnl.length > 0
    ? Math.round((withPnl.reduce((s, p) => s + p.peak_pnl_pct, 0) / withPnl.length) * 100) / 100
    : null;
  const wins = withPnl.filter((p) => p.peak_pnl_pct > 1).length;
  const winRate = withPnl.length > 0
    ? Math.round((wins / withPnl.length) * 100)
    : null;

  // Build deploys array for consecutive loss counting
  const deploysForLossCount = sorted
    .slice()
    .reverse() // oldest first
    .map((p) => ({ pnl_pct: p.peak_pnl_pct ?? 0 }));
  const consecutiveLosses = countConsecutiveLosses(deploysForLossCount);

  // Extract signal snapshot from the last deploy
  const lastSnapshot = lastDeploy.signal_snapshot;

  // Determine last close reason from notes
  // Note format: "Closed at 2026-05-25T01:14:45.836Z: Dumped far below range"
  const closeNotes = (lastDeploy.notes || []).filter((n) => n.startsWith("Closed at"));
  const lastCloseReason = closeNotes.length > 0
    ? closeNotes[closeNotes.length - 1].replace(/^Closed at .+?: /, "")
    : null;

  const result = {
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

  log("state_history", `Enriched ${poolAddress?.slice(0, 8)}: ${sorted.length} deploys, last=${lastOutcome}, ${minutesSinceClose}m ago, consecutive_losses=${consecutiveLosses}`);

  return result;
}

/**
 * Enrich an array of candidate pools with history data.
 * Mutates each pool object in-place by adding a `history` field.
 * Never throws — if enrichment fails for any pool, attaches history.found: false.
 *
 * @param {Array} candidates - Array of pool objects (each needs .pool and .base.mint)
 */
export function enrichCandidatesWithHistory(candidates) {
  if (!Array.isArray(candidates)) return;

  for (const pool of candidates) {
    try {
      const poolAddress = pool.pool;
      const baseMint = pool.base?.mint;
      const { history } = enrichHistory(poolAddress, baseMint);
      pool.history = history;
    } catch (err) {
      log("state_history", `Enrichment failed for ${pool.name || pool.pool}: ${err.message}`);
      pool.history = { found: false };
    }
  }
}
