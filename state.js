/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
    if (text == null) return null;
    const cleaned = String(text)
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[<>`]/g, "")
        .trim()
        .slice(0, maxLen);
    return cleaned || null;
}

function load() {
    if (!fs.existsSync(STATE_FILE)) {
        return { positions: {}, recentEvents: [], lastUpdated: null };
    }
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (err) {
        log("state_error", `Failed to read state.json: ${err.message}`);
        return { positions: {}, lastUpdated: null };
    }
}

function save(state) {
    try {
        state.lastUpdated = new Date().toISOString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        log("state_error", `Failed to write state.json: ${err.message}`);
    }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
    position,
    pool,
    pool_name,
    strategy,
    bin_range = {},
    amount_sol,
    amount_x = 0,
    active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot = null,
    entry_volume = null,
    entry_timeframe = null,
}) {
    const state = load();
    state.positions[position] = {
        position,
        pool,
        pool_name,
        strategy,
        bin_range,
        amount_sol,
        amount_x,
        active_bin_at_deploy: active_bin,
        bin_step,
        volatility,
        fee_tvl_ratio,
        initial_fee_tvl_24h: fee_tvl_ratio,
        organic_score,
        initial_value_usd,
        signal_snapshot: signal_snapshot || null,
        deployed_at: new Date().toISOString(),
        out_of_range_since: null,
        last_claim_at: null,
        total_fees_claimed_usd: 0,
        rebalance_count: 0,
        closed: false,
        closed_at: null,
        notes: [],
        peak_pnl_pct: 0,
        pending_peak_pnl_pct: null,
        pending_peak_started_at: null,
        pending_trailing_current_pnl_pct: null,
        pending_trailing_peak_pnl_pct: null,
        pending_trailing_drop_pct: null,
        pending_trailing_started_at: null,
        confirmed_trailing_exit_reason: null,
        confirmed_trailing_exit_until: null,
        trailing_active: false,
        pending_stop_loss_pnl_pct: null,
        pending_stop_loss_started_at: null,
        confirmed_stop_loss_exit_reason: null,
        confirmed_stop_loss_exit_until: null,
        pending_il_stop_il_pct: null,
        pending_il_stop_il_usd: null,
        pending_il_stop_days_to_recover: null,
        pending_il_stop_fee_source: null,
        pending_il_stop_projected_daily_fee: null,
        pending_il_stop_started_at: null,
        confirmed_il_stop_exit_reason: null,
        confirmed_il_stop_exit_until: null,
        last_recompound_at: null,
        entry_fee_rate: null, // fees per minute at deploy time
        peak_fee_rate: null, // highest fee rate observed since entry
        entry_volume: entry_volume ?? null, // pool volume at deploy time (timeframe-windowed)
        entry_timeframe: entry_timeframe ?? null, // screening timeframe used at entry
    };
    pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
    save(state);
    log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return;
    if (!pos.out_of_range_since) {
        pos.out_of_range_since = new Date().toISOString();
        save(state);
        log("state", `Position ${position_address} marked out of range`);
    }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return;
    if (pos.out_of_range_since) {
        pos.out_of_range_since = null;
        save(state);
        log("state", `Position ${position_address} back in range`);
    }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || !pos.out_of_range_since) return 0;
    const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
    return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return;
    pos.last_claim_at = new Date().toISOString();
    pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
    pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
    save(state);
}

/**
 * Record a recompound event (claim fees + add X token back).
 */
export function recordRecompound(position_address, amount_x) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return;
    pos.last_recompound_at = new Date().toISOString();
    pos.notes.push(`Recompounded ${amount_x?.toFixed(4) || "?"} X token at ${pos.last_recompound_at}`);
    pushEvent(state, { action: "recompound", position: position_address, amount_x });
    save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
    if (!state.recentEvents) state.recentEvents = [];
    state.recentEvents.push({ ts: new Date().toISOString(), ...event });
    if (state.recentEvents.length > MAX_RECENT_EVENTS) {
        state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return;
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
    pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
    save(state);
    log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
    const state = load();
    const old = state.positions[old_position];
    if (old) {
        old.closed = true;
        old.closed_at = new Date().toISOString();
        old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
    }
    const newPos = state.positions[new_position];
    if (newPos) {
        newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
        newPos.notes.push(`Rebalanced from ${old_position}`);
    }
    save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos) return false;
    pos.instruction = sanitizeStoredText(instruction);
    save(state);
    log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
    return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct) {
    if (candidatePnlPct == null) return false;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return false;

    const currentPeak = pos.peak_pnl_pct ?? 0;
    if (candidatePnlPct <= currentPeak) return false;

    const changed = pos.pending_peak_pnl_pct == null || candidatePnlPct > pos.pending_peak_pnl_pct;

    if (!changed) return false;

    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_started_at = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
    return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

    const pendingPeak = pos.pending_peak_pnl_pct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;

    if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
        pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
        save(state);
        log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
        return { confirmed: true, peak: pos.peak_pnl_pct };
    }

    save(state);
    log(
        "state",
        `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`,
    );
    return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
    if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
    const dropFromPeak = peakPnlPct - currentPnlPct;
    if (dropFromPeak < trailingDropPct) return false;

    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return false;

    const changed =
        pos.pending_trailing_current_pnl_pct == null ||
        currentPnlPct < pos.pending_trailing_current_pnl_pct ||
        dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

    if (!changed) return false;

    pos.pending_trailing_peak_pnl_pct = peakPnlPct;
    pos.pending_trailing_current_pnl_pct = currentPnlPct;
    pos.pending_trailing_drop_pct = dropFromPeak;
    pos.pending_trailing_started_at = new Date().toISOString();
    save(state);
    log(
        "state",
        `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`,
    );
    return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
        return { confirmed: false, pending: false };
    }

    const pendingCurrent = pos.pending_trailing_current_pnl_pct;
    const pendingPeak = pos.pending_trailing_peak_pnl_pct;
    const pendingDrop = pos.pending_trailing_drop_pct ?? pendingPeak - pendingCurrent;

    pos.pending_trailing_current_pnl_pct = null;
    pos.pending_trailing_peak_pnl_pct = null;
    pos.pending_trailing_drop_pct = null;
    pos.pending_trailing_started_at = null;

    const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
    const stillDroppedEnough = currentPnlPct != null && pendingPeak - currentPnlPct >= trailingDropPct;

    if (stillNearCrash && stillDroppedEnough) {
        const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
        pos.confirmed_trailing_exit_reason = reason;
        pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
        save(state);
        log(
            "state",
            `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`,
        );
        return { confirmed: true, reason };
    }

    save(state);
    log(
        "state",
        `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`,
    );
    return { confirmed: false, rejected: true };
}

export function queueStopLossConfirmation(position_address, currentPnlPct, stopLossPct) {
    if (currentPnlPct == null) return false;
    if (currentPnlPct > stopLossPct) return false;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return false;

    const changed = pos.pending_stop_loss_pnl_pct == null || currentPnlPct < pos.pending_stop_loss_pnl_pct;

    if (!changed) return false;

    pos.pending_stop_loss_pnl_pct = currentPnlPct;
    pos.pending_stop_loss_started_at = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} stop loss candidate ${currentPnlPct.toFixed(2)}% queued for 15s confirmation`);
    return true;
}

export function resolvePendingStopLoss(position_address, currentPnlPct, stopLossPct, tolerancePct = 1.0) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed || pos.pending_stop_loss_pnl_pct == null) {
        return { confirmed: false, pending: false };
    }

    const pendingPnl = pos.pending_stop_loss_pnl_pct;
    pos.pending_stop_loss_pnl_pct = null;
    pos.pending_stop_loss_started_at = null;

    const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingPnl + tolerancePct;
    const stillBelowStopLoss = currentPnlPct != null && currentPnlPct <= stopLossPct;

    if (stillNearCrash && stillBelowStopLoss) {
        const reason = `Stop loss confirmed: PnL ${currentPnlPct.toFixed(2)}% <= ${stopLossPct}% (was ${pendingPnl.toFixed(2)}% at queue)`;
        pos.confirmed_stop_loss_exit_reason = reason;
        pos.confirmed_stop_loss_exit_until = new Date(Date.now() + 30_000).toISOString();
        save(state);
        log("state", `Position ${position_address} stop loss confirmed after recheck: pending ${pendingPnl.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
        return { confirmed: true, reason };
    }

    save(state);
    log("state", `Position ${position_address} rejected stop loss after 15s recheck (pending: ${pendingPnl.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
    return { confirmed: false, rejected: true };
}

export function queueILStopConfirmation(position_address, ilMetrics) {
    if (!ilMetrics) return false;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return false;

    // Only queue if IL is worse (deeper) than what's already pending
    const worse = pos.pending_il_stop_il_pct == null || ilMetrics.ilPct < pos.pending_il_stop_il_pct;
    if (!worse) return false;

    pos.pending_il_stop_il_pct = ilMetrics.ilPct;
    pos.pending_il_stop_il_usd = ilMetrics.ilUsd;
    pos.pending_il_stop_days_to_recover = ilMetrics.daysToRecover;
    pos.pending_il_stop_fee_source = ilMetrics.feeSource;
    pos.pending_il_stop_projected_daily_fee = ilMetrics.projectedDailyFee;
    pos.pending_il_stop_started_at = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} IL stop candidate IL ${ilMetrics.ilPct.toFixed(1)}% queued for 15s confirmation`);
    return true;
}

export function resolvePendingILStop(position_address, positionData, mgmtConfig, tolerancePct = 1.0) {
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed || pos.pending_il_stop_il_pct == null) {
        return { confirmed: false, pending: false };
    }

    const pendingIlPct = pos.pending_il_stop_il_pct;
    const pendingIlUsd = pos.pending_il_stop_il_usd;
    const pendingDays = pos.pending_il_stop_days_to_recover;
    const pendingFeeSource = pos.pending_il_stop_fee_source;
    const pendingDailyFee = pos.pending_il_stop_projected_daily_fee;

    // Clear pending fields
    pos.pending_il_stop_il_pct = null;
    pos.pending_il_stop_il_usd = null;
    pos.pending_il_stop_days_to_recover = null;
    pos.pending_il_stop_fee_source = null;
    pos.pending_il_stop_projected_daily_fee = null;
    pos.pending_il_stop_started_at = null;

    // Re-compute IL from fresh on-chain data
    const il = computeILMetrics(positionData);
    if (!il) {
        save(state);
        log("state", `Position ${position_address} rejected IL stop after 15s recheck (IL no longer negative)`);
        return { confirmed: false, rejected: true };
    }

    // IL must still be near the pending level (within tolerance) AND still triggerable
    const stillNearPending = il.ilPct <= pendingIlPct + tolerancePct;
    const stillTriggerable = shouldTriggerILStop(il, mgmtConfig);

    if (stillNearPending && stillTriggerable) {
        const reason = `IL stop confirmed: IL ${il.ilPct.toFixed(1)}% ($${Math.abs(il.ilUsd).toFixed(2)}), recovery ${il.daysToRecover.toFixed(1)}d at $${il.projectedDailyFee.toFixed(2)}/d (${il.feeSource}) [recheck from ${pendingIlPct.toFixed(1)}%]`;
        pos.confirmed_il_stop_exit_reason = reason;
        pos.confirmed_il_stop_exit_until = new Date(Date.now() + 30_000).toISOString();
        save(state);
        log("state", `Position ${position_address} IL stop confirmed after recheck: pending ${pendingIlPct.toFixed(1)}%, current ${il.ilPct.toFixed(1)}%`);
        return { confirmed: true, reason };
    }

    save(state);
    log("state", `Position ${position_address} rejected IL stop after 15s recheck (pending: ${pendingIlPct.toFixed(1)}%, current: ${il.ilPct.toFixed(1)}%)`);
    return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
    const state = load();
    const all = Object.values(state.positions);
    return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
    const state = load();
    return state.positions[position_address] || null;
}

/**
 * Set the entry fee rate for a position (called once at deploy time).
 * feeRate is in USD/minute, derived from pool fees_1h / 60.
 */
export function setEntryFeeRate(position_address, feeRate) {
    if (feeRate == null || feeRate <= 0) return;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return;
    pos.entry_fee_rate = feeRate;
    pos.peak_fee_rate = feeRate;
    save(state);
    log("state", `Position ${position_address} entry fee rate set: ${feeRate.toFixed(6)} USD/min`);
}

export function setEntryVolume(position_address, volume, timeframe) {
    if (volume == null || volume <= 0) return;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return;
    pos.entry_volume = volume;
    pos.entry_timeframe = timeframe || null;
    save(state);
    log("state", `Position ${position_address} entry volume set: $${volume} [${timeframe}]`);
}

/**
 * Compute fee rate decay from peak since entry.
 * Returns { entryFeeRate, peakFeeRate, currentFeeRate, decayPct } or null if data unavailable.
 *
 * @param {number|null} poolFees1h - Pool fees in last 1h (USD)
 * @param {object} trackedPos - Tracked position state with entry_fee_rate, peak_fee_rate
 * @returns {object|null}
 */
export function computeFeeRateDecay(poolFees1h, trackedPos) {
    if (!trackedPos || poolFees1h == null || poolFees1h < 0) return null;
    if (!trackedPos.peak_fee_rate || trackedPos.peak_fee_rate <= 0) return null;

    const currentFeeRate = poolFees1h / 60; // USD per minute
    const peakFeeRate = trackedPos.peak_fee_rate;
    const entryFeeRate = trackedPos.entry_fee_rate ?? peakFeeRate;

    const decayPct = peakFeeRate > 0
        ? ((peakFeeRate - currentFeeRate) / peakFeeRate) * 100
        : 0;

    return { entryFeeRate, peakFeeRate, currentFeeRate, decayPct: Math.max(0, decayPct) };
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
    const state = load();
    const open = Object.values(state.positions).filter((p) => !p.closed);
    const closed = Object.values(state.positions).filter((p) => p.closed);
    const totalFeesClaimed = Object.values(state.positions).reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

    return {
        open_positions: open.length,
        closed_positions: closed.length,
        total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
        positions: open.map((p) => ({
            position: p.position,
            pool: p.pool,
            strategy: p.strategy,
            deployed_at: p.deployed_at,
            out_of_range_since: p.out_of_range_since,
            minutes_out_of_range: minutesOutOfRange(p.position),
            total_fees_claimed_usd: p.total_fees_claimed_usd,
            initial_fee_tvl_24h: p.initial_fee_tvl_24h,
            rebalance_count: p.rebalance_count,
            instruction: p.instruction || null,
        })),
        last_updated: state.lastUpdated,
        recent_events: (state.recentEvents || []).slice(-10),
    };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function computeILMetrics(p) {
    const totalFees = (p.unclaimed_fees_usd ?? 0) + (p.collected_fees_usd ?? 0);
    const ilUsd = (p.pnl_usd ?? 0) - totalFees;
    if (ilUsd >= 0) return null;
    const totalValueUsd = p.total_value_usd;
    const pnlUsd = p.pnl_usd;
    if (totalValueUsd == null || pnlUsd == null) return null;
    const initialValue = totalValueUsd - pnlUsd;
    if (initialValue <= 0) return null;
    const ilPct = (ilUsd / initialValue) * 100;
    const ageMinutes = p.age_minutes ?? 0;

    // Use active_tvl when available (only liquidity in-range earns fees)
    const poolTvl = p.pool_active_tvl ?? p.pool_tvl;

    // Project daily fee using best available source
    // Priority: pool fees (actual, freshest) > position fee rate (concentration-aware) > historical
    let projectedDailyFee = null;
    let feeSource = null;

    // 1. Pool-level actual fees + position share of active TVL
    if (p.pool_fees_1h != null && poolTvl > 0 && totalValueUsd > 0) {
        const positionShare = totalValueUsd / poolTvl;
        projectedDailyFee = p.pool_fees_1h * 24 * positionShare;
        feeSource = "pool_1h";
    } else if (p.pool_fees_24h != null && poolTvl > 0 && totalValueUsd > 0) {
        const positionShare = totalValueUsd / poolTvl;
        projectedDailyFee = p.pool_fees_24h * positionShare;
        feeSource = "pool_24h";
    }
    // 2. Position-specific fee rate (concentration-aware but can be stale)
    else if (p.fee_per_tvl_24h != null && p.fee_per_tvl_24h > 0) {
        projectedDailyFee = (p.fee_per_tvl_24h / 100) * totalValueUsd;
        feeSource = "position_rate";
    }
    // 3. Historical earning rate (what the position actually earned so far)
    else if (ageMinutes >= 30 && totalFees > 0) {
        projectedDailyFee = totalFees / (ageMinutes / 1440);
        feeSource = "historical";
    }

    let daysToRecover = projectedDailyFee != null && projectedDailyFee > 0 ? Math.abs(ilUsd) / projectedDailyFee : null;

    // Adjust recovery for volatility: higher vol = IL accumulates faster, so effective recovery is longer
    // IL scales with σ²; at high volatility (>5), projected IL growth outpaces fee earning
    const volatility = p.pool_volatility;
    if (daysToRecover != null && volatility != null && volatility > 5) {
        const volPenalty = 1 + (volatility - 5) * 0.05; // 5% penalty per vol point above 5
        daysToRecover *= volPenalty;
    }

    return { ilUsd, ilPct, totalFees, daysToRecover, feeSource, projectedDailyFee, initialValue, totalValueUsd, ageMinutes, volatility };
}

export function shouldTriggerILStop(il, mgmtConfig) {
    return (
        il &&
        il.ilPct <= mgmtConfig.ilStopMinPct &&
        il.ageMinutes >= mgmtConfig.ilStopMinAgeMinutes &&
        il.daysToRecover != null &&
        il.daysToRecover >= mgmtConfig.ilRecoveryMaxDays
    );
}

/**
 * Compute volume decay percentage between entry and current.
 * Returns null if entry volume is zero/undefined (cannot compute).
 * Returns the percentage drop: 70 means volume dropped 70% from entry.
 */
export function computeVolumeDecayPct(entryVolume, currentVolume) {
    if (entryVolume == null || entryVolume <= 0) return null;
    const current = Math.max(0, currentVolume ?? 0);
    const decay = ((entryVolume - current) / entryVolume) * 100;
    return Math.max(0, decay);
}

/**
 * Check whether a position should be closed due to volume decay.
 * @param {object} trackedPos — state.js position record (needs entry_volume, entry_timeframe, deployed_at, total_fees_claimed_usd)
 * @param {number} currentVolume — fresh volume from pool discovery API using entry_timeframe
 * @param {number} managementIntervalMin — current management interval (for warmup guard)
 * @param {object} mgmtConfig — config.management
 * @param {number} unclaimedFeesUsd — current unclaimed fees from live position data
 * Returns { triggered, decayPct, entryVolume, currentVolume, timeframe, reason } or null.
 */
export function checkVolumeDecay(trackedPos, currentVolume, mgmtConfig, unclaimedFeesUsd = 0) {
    const threshold = mgmtConfig.volumeDecayPct;
    if (threshold == null || threshold <= 0) return null;

    const entryVolume = trackedPos.entry_volume;
    const timeframe = trackedPos.entry_timeframe;
    if (entryVolume == null || entryVolume <= 0) {
        log("state_warn", `Volume decay skipped for ${trackedPos.position}: entryVolume is ${entryVolume}`);
        return null;
    }
    if (!timeframe) {
        log("state_warn", `Volume decay skipped for ${trackedPos.position}: no entryTimeframe stored`);
        return null;
    }

    // Warmup: same guard as yield check and fee rate decay
    const minAgeMin = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
    const deployedAt = trackedPos.deployed_at ? new Date(trackedPos.deployed_at).getTime() : 0;
    const ageMinutes = (Date.now() - deployedAt) / 60_000;
    if (ageMinutes < minAgeMin) return null;

    const current = Math.max(0, currentVolume ?? 0);
    const decayPct = computeVolumeDecayPct(entryVolume, current);
    if (decayPct == null) return null;

    if (decayPct < threshold) return null;

    // Guard: minimum fees earned before triggering
    const totalFees = (trackedPos.total_fees_claimed_usd ?? 0) + (unclaimedFeesUsd ?? 0);
    const minFees = mgmtConfig.minFeesBeforeExit ?? 0;
    if (totalFees < minFees) return null;

    const reason = `Volume decay: entry $${entryVolume} → current $${current} (dropped ${decayPct.toFixed(1)}% >= ${threshold}%) [${timeframe}]`;
    return {
        triggered: true,
        decayPct,
        entryVolume,
        currentVolume: current,
        timeframe,
        reason,
    };
}

export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
    const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
    const state = load();
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return null;

    // ── Confirmed stop loss (awaiting execution, highest priority) ──
    if (pos.confirmed_stop_loss_exit_until) {
        if (new Date(pos.confirmed_stop_loss_exit_until).getTime() > Date.now() && pos.confirmed_stop_loss_exit_reason) {
            const reason = pos.confirmed_stop_loss_exit_reason;
            pos.confirmed_stop_loss_exit_reason = null;
            pos.confirmed_stop_loss_exit_until = null;
            save(state);
            return { action: "STOP_LOSS", reason, confirmed_recheck: true };
        }
        pos.confirmed_stop_loss_exit_reason = null;
        pos.confirmed_stop_loss_exit_until = null;
    }

    if (pos.confirmed_trailing_exit_until) {
        if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
            const reason = pos.confirmed_trailing_exit_reason;
            pos.confirmed_trailing_exit_reason = null;
            pos.confirmed_trailing_exit_until = null;
            save(state);
            return { action: "TRAILING_TP", reason, confirmed_recheck: true };
        }
        pos.confirmed_trailing_exit_reason = null;
        pos.confirmed_trailing_exit_until = null;
    }

    if (pos.confirmed_il_stop_exit_until) {
        if (new Date(pos.confirmed_il_stop_exit_until).getTime() > Date.now() && pos.confirmed_il_stop_exit_reason) {
            const reason = pos.confirmed_il_stop_exit_reason;
            pos.confirmed_il_stop_exit_reason = null;
            pos.confirmed_il_stop_exit_until = null;
            save(state);
            return { action: "IL_STOP", reason, confirmed_recheck: true };
        }
        pos.confirmed_il_stop_exit_reason = null;
        pos.confirmed_il_stop_exit_until = null;
    }

    let changed = false;

    // Activate trailing TP once trigger threshold is reached
    if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
        pos.trailing_active = true;
        changed = true;
        log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
    }

    // Update OOR state
    if (in_range === false && !pos.out_of_range_since) {
        pos.out_of_range_since = new Date().toISOString();
        changed = true;
        log("state", `Position ${position_address} marked out of range`);
    } else if (in_range === true && pos.out_of_range_since) {
        pos.out_of_range_since = null;
        changed = true;
        log("state", `Position ${position_address} back in range`);
    }

    if (changed) save(state);

    // ── Stop loss ──────────────────────────────────────────────────
    if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
        return {
            action: "STOP_LOSS",
            reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
            needs_confirmation: true,
            current_pnl_pct: currentPnlPct,
        };
    }

    // ── Take profit ───────────────────────────────────────────────
    if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.takeProfitPct != null && currentPnlPct >= mgmtConfig.takeProfitPct) {
        return {
            action: "TAKE_PROFIT",
            reason: `Take profit: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.takeProfitPct}%`,
        };
    }

    // ── Dynamic IL stop-loss (fees can't recover impermanent loss) ─
    if (mgmtConfig.dynamicILStop && !pnl_pct_suspicious) {
        const il = computeILMetrics(positionData);
        if (shouldTriggerILStop(il, mgmtConfig)) {
            return {
                action: "IL_STOP",
                reason: `IL stop: IL ${il.ilPct.toFixed(1)}% ($${Math.abs(il.ilUsd).toFixed(2)}), recovery ${il.daysToRecover.toFixed(1)}d at $${il.projectedDailyFee.toFixed(2)}/d (${il.feeSource})`,
                needs_confirmation: true,
                il_metrics: il,
            };
        }
    }

    // ── Trailing TP ────────────────────────────────────────────────
    if (!pnl_pct_suspicious && pos.trailing_active) {
        const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
        if (dropFromPeak >= mgmtConfig.trailingDropPct) {
            return {
                action: "TRAILING_TP",
                reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
                needs_confirmation: true,
                peak_pnl_pct: pos.peak_pnl_pct,
                current_pnl_pct: currentPnlPct,
                drop_from_peak_pct: dropFromPeak,
            };
        }
    }

    // ── Out of range too long ──────────────────────────────────────
    if (pos.out_of_range_since) {
        const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
        if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
            return {
                action: "OUT_OF_RANGE",
                reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
            };
        }
    }

    // ── Low yield (only after position has had time to accumulate fees) ───
    const { age_minutes } = positionData;
    const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
    if (
        fee_per_tvl_24h != null &&
        mgmtConfig.minFeePerTvl24h != null &&
        fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
        (age_minutes == null || age_minutes >= minAgeForYieldCheck)
    ) {
        return {
            action: "LOW_YIELD",
            reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
        };
    }

    // ── Fee rate decay exit (fee momentum fading) ─────────────────────
    if (mgmtConfig.feeRateDropPct != null && mgmtConfig.feeRateDropPct > 0) {
        const decay = computeFeeRateDecay(positionData.pool_fees_1h, pos);
        if (decay && decay.peakFeeRate > 0) {
            // Update peak if current rate is higher
            if (decay.currentFeeRate > pos.peak_fee_rate) {
                pos.peak_fee_rate = decay.currentFeeRate;
                changed = true;
                // Recompute decay with updated peak
                decay.peakFeeRate = decay.currentFeeRate;
                decay.decayPct = 0;
            }

            if (changed) save(state);

            // Guards: skip if too young (< 2 monitoring intervals) or fees too low
            // const intervalMin = mgmtConfig.managementIntervalMin ?? 10;
            const minAgeForFeeRateCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
            if (age_minutes != null && age_minutes < minAgeForFeeRateCheck) {
                return null;
            }
            const totalFeesEarned = (positionData.unclaimed_fees_usd ?? 0) + (positionData.collected_fees_usd ?? 0);
            const minFees = mgmtConfig.minFeesBeforeFeeRateExit ?? 0.5;
            if (totalFeesEarned < minFees) {
                return null;
            }

            if (decay.decayPct >= mgmtConfig.feeRateDropPct) {
                log(
                    "state",
                    `Fee rate decay exit: ${pos.pool_name ?? position_address} — entry=${decay.entryFeeRate.toFixed(6)}, peak=${decay.peakFeeRate.toFixed(6)}, current=${decay.currentFeeRate.toFixed(6)}, decay=${decay.decayPct.toFixed(1)}%, threshold=${mgmtConfig.feeRateDropPct}%`,
                );
                return {
                    action: "FEE_RATE_DECAY",
                    reason: `Fee rate decay: peak $${(decay.peakFeeRate * 60).toFixed(2)}/h → current $${(decay.currentFeeRate * 60).toFixed(2)}/h (dropped ${decay.decayPct.toFixed(1)}% >= ${mgmtConfig.feeRateDropPct}%)`,
                };
            }
        }
    }

    return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
    const state = load();
    return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
    const state = load();
    state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
    const state = load();
    const activeSet = new Set(active_addresses);
    let changed = false;

    for (const posId in state.positions) {
        const pos = state.positions[posId];
        if (pos.closed || activeSet.has(posId)) continue;

        // Grace period: newly deployed positions may not be indexed yet
        const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
        if (Date.now() - deployedAt < SYNC_GRACE_MS) {
            log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
            continue;
        }

        pos.closed = true;
        pos.closed_at = new Date().toISOString();
        pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
        changed = true;
        log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
    }

    if (changed) save(state);
}
