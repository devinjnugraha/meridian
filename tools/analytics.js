/**
 * Analytics tools — pool history and portfolio risk.
 *
 * get_pool_history: fetches historical volatility/fee trends for a pool
 * get_portfolio_risk: computes exposure per token, VaR_95, max correlation
 */

import { getMyPositions, getPositionPnl } from "./dlmm.js";
import { getWalletBalances } from "./wallet.js";
import { getPoolDetail } from "./screening.js";
import { getPerformanceHistory } from "../lessons.js";
import { log } from "../logger.js";

// ─── Pool History ──────────────────────────────────────────────

/**
 * Get historical trend data for a pool.
 * Fetches current and recent pool metrics, plus any deploy history from pool memory.
 *
 * @param {Object} opts
 * @param {string} opts.pool - Pool address
 * @param {number} opts.hours - Hours of history to look back (default 24)
 * @returns {{ vol_trend: Array, fee_tvl_trend: Array }}
 */
export async function getPoolHistory({ pool, hours = 24 }) {
  if (!pool) return { error: "pool address required" };

  try {
    // Fetch current pool detail across multiple timeframes for trend data
    const [detail5m, detail1h, detail4h] = await Promise.allSettled([
      getPoolDetail({ pool_address: pool, timeframe: "5m" }),
      getPoolDetail({ pool_address: pool, timeframe: "1h" }),
      getPoolDetail({ pool_address: pool, timeframe: "4h" }),
    ]);

    const volTrend = [];
    const feeTvlTrend = [];

    // Build trend from multi-timeframe snapshots
    if (detail5m.status === "fulfilled" && detail5m.value) {
      const d = detail5m.value;
      volTrend.push({ t: "5m", volatility: d.volatility ?? null, volume: d.volume_window ?? null });
      feeTvlTrend.push({ t: "5m", fee_tvl_ratio: d.fee_active_tvl_ratio ?? null, tvl: d.active_tvl ?? null });
    }
    if (detail1h.status === "fulfilled" && detail1h.value) {
      const d = detail1h.value;
      volTrend.push({ t: "1h", volatility: d.volatility ?? null, volume: d.volume_window ?? null });
      feeTvlTrend.push({ t: "1h", fee_tvl_ratio: d.fee_active_tvl_ratio ?? null, tvl: d.active_tvl ?? null });
    }
    if (detail4h.status === "fulfilled" && detail4h.value) {
      const d = detail4h.value;
      volTrend.push({ t: "4h", volatility: d.volatility ?? null, volume: d.volume_window ?? null });
      feeTvlTrend.push({ t: "4h", fee_tvl_ratio: d.fee_active_tvl_ratio ?? null, tvl: d.active_tvl ?? null });
    }

    // Add performance history from our own records
    const perfHistory = getPerformanceHistory({ hours, limit: 50 });
    const poolPerf = (perfHistory.positions || []).filter(p => p.pool === pool);

    const result = { vol_trend: volTrend, fee_tvl_trend: feeTvlTrend };

    if (poolPerf.length > 0) {
      result.own_history = {
        deploys: poolPerf.length,
        avg_pnl_pct: poolPerf.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / poolPerf.length,
        win_rate: poolPerf.filter(p => (p.pnl_usd ?? 0) > 0).length / poolPerf.length,
        total_pnl_usd: poolPerf.reduce((s, p) => s + (p.pnl_usd ?? 0), 0),
      };
    }

    return result;
  } catch (e) {
    log("analytics_error", `getPoolHistory failed for ${pool}: ${e.message}`);
    return { error: e.message, vol_trend: [], fee_tvl_trend: [] };
  }
}

// ─── Portfolio Risk ────────────────────────────────────────────

/**
 * Compute portfolio risk metrics.
 *
 * @returns {{ exposure_per_token: Object, var_95: number, max_corr: number, concentration_warning: string|null }}
 */
export async function getPortfolioRisk() {
  try {
    const [wallet, positionsResult] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }).catch(() => ({ positions: [], total_positions: 0 })),
    ]);

    const positions = positionsResult.positions || [];
    if (positions.length === 0) {
      return {
        exposure_per_token: {},
        total_value_usd: wallet.total_usd ?? 0,
        sol_balance: wallet.sol ?? 0,
        var_95: 0,
        max_corr: 0,
        concentration_warning: null,
      };
    }

    // Calculate total portfolio value
    const positionValues = positions.map(p => ({
      ...p,
      value_usd: p.total_value_usd ?? 0,
      pair: p.pair || "unknown",
      base_mint: p.base_mint || null,
    }));
    const totalValue = positionValues.reduce((s, p) => s + p.value_usd, 0) + (wallet.total_usd - wallet.sol_usd || 0);
    const totalPortfolioValue = totalValue > 0 ? totalValue : 1;

    // Exposure per token (by pair name)
    const exposurePerToken = {};
    for (const p of positionValues) {
      const token = p.pair?.split("-")[0] || p.pair || "unknown";
      if (!exposurePerToken[token]) {
        exposurePerToken[token] = { value_usd: 0, pct_of_portfolio: 0, positions: 0 };
      }
      exposurePerToken[token].value_usd += p.value_usd;
      exposurePerToken[token].positions += 1;
    }

    // Calculate percentages
    let maxConcentration = 0;
    let maxConcentrationToken = null;
    for (const [token, data] of Object.entries(exposurePerToken)) {
      data.pct_of_portfolio = totalPortfolioValue > 0
        ? Math.round((data.value_usd / totalPortfolioValue) * 10000) / 100
        : 0;
      if (data.pct_of_portfolio > maxConcentration) {
        maxConcentration = data.pct_of_portfolio;
        maxConcentrationToken = token;
      }
    }

    // Historical VaR_95 based on past performance
    const perfHistory = getPerformanceHistory({ hours: 168, limit: 100 });
    const perfPositions = perfHistory.positions || [];
    let var95 = 0;
    if (perfPositions.length >= 10) {
      const pnlPcts = perfPositions.map(p => p.pnl_pct ?? 0).sort((a, b) => a - b);
      const idx5 = Math.floor(pnlPcts.length * 0.05);
      var95 = pnlPcts[idx5] ?? 0;
    }

    // Max correlation proxy — based on co-movement of same-token positions
    // Simple heuristic: if multiple positions share correlated tokens, flag it
    const tokenPairs = Object.entries(exposurePerToken).filter(([, d]) => d.positions > 1);
    const maxCorr = tokenPairs.length > 0 ? 0.85 : positions.length > 1 ? 0.3 : 0;

    // Concentration warning
    let concentrationWarning = null;
    if (maxConcentration > 20) {
      concentrationWarning = `Token "${maxConcentrationToken}" at ${maxConcentration.toFixed(1)}% — above 20% diversification limit`;
    }

    return {
      exposure_per_token: exposurePerToken,
      total_value_usd: Math.round(totalPortfolioValue * 100) / 100,
      sol_balance: wallet.sol ?? 0,
      sol_pct: totalPortfolioValue > 0
        ? Math.round(((wallet.sol_usd ?? 0) / totalPortfolioValue) * 10000) / 100
        : 0,
      var_95: Math.round(var95 * 100) / 100,
      max_corr: maxCorr,
      open_positions: positions.length,
      concentration_warning: concentrationWarning,
    };
  } catch (e) {
    log("analytics_error", `getPortfolioRisk failed: ${e.message}`);
    return { error: e.message, exposure_per_token: {}, var_95: 0, max_corr: 0 };
  }
}
