/**
 * Lesson-based pool scoring.
 *
 * Parses saved lessons and matches them against pool characteristics
 * to produce a score modifier: +25% for GOOD matches, -25% for BAD.
 *
 * Used during screening to boost/penalize candidates based on
 * historical patterns the agent has learned.
 */

import { log } from "./logger.js";
import fs from "fs";

const LESSONS_FILE = "./lessons.json";

function loadLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    return data.lessons || [];
  } catch {
    return [];
  }
}

/**
 * Extract numeric characteristics from a lesson rule for matching.
 * Returns { volatility, bin_step, strategy, pool_name, direction } or null.
 */
function parseLessonSignals(rule) {
  if (!rule) return null;

  const text = rule.toLowerCase();
  const direction = text.startsWith("prefer") || text.startsWith("worked")
    ? "GOOD"
    : text.startsWith("avoid") || text.startsWith("failed")
      ? "BAD"
      : "NEUTRAL";

  // Extract volatility
  const volMatch = text.match(/volatility[=~<>]*(\d+(?:\.\d+)?)/);
  const volatility = volMatch ? parseFloat(volMatch[1]) : null;

  // Extract bin_step
  const binMatch = text.match(/bin_step[=~<>]*(\d+)/);
  const bin_step = binMatch ? parseInt(binMatch[1]) : null;

  // Extract strategy
  const stratMatch = text.match(/strategy[=~>"']*(bid_ask|spot|curve)/);
  const strategy = stratMatch ? stratMatch[1] : null;

  // Extract pool name hint (e.g., "Tortellini-SOL-type")
  const poolMatch = text.match(/([a-z]+(?:-[a-z]+)*)-type/i);
  const pool_hint = poolMatch ? poolMatch[1].toLowerCase() : null;

  // Extract fee_tvl_ratio
  const feeMatch = text.match(/fee_tvl_ratio[=~<>]*(\d+(?:\.\d+)?)/);
  const fee_tvl_ratio = feeMatch ? parseFloat(feeMatch[1]) : null;

  // Extract range efficiency
  const rangeMatch = text.match(/range efficiency (\d+)/);
  const range_efficiency = rangeMatch ? parseInt(rangeMatch[1]) : null;

  return {
    volatility,
    bin_step,
    strategy,
    pool_hint,
    fee_tvl_ratio,
    range_efficiency,
    direction,
  };
}

/**
 * Check how well a pool matches a lesson's signals.
 * Returns a match score 0-1.
 */
function matchScore(pool, signals) {
  if (!signals) return 0;

  let score = 0;
  let factors = 0;

  // Volatility match (within ±2)
  if (signals.volatility != null && pool.volatility != null) {
    factors++;
    if (Math.abs(pool.volatility - signals.volatility) <= 2.0) {
      score += 1;
    } else if (Math.abs(pool.volatility - signals.volatility) <= 4.0) {
      score += 0.5;
    }
  }

  // Bin step match
  if (signals.bin_step != null && pool.bin_step != null) {
    factors++;
    if (pool.bin_step === signals.bin_step) score += 1;
  }

  // Fee/TVL range match
  if (signals.fee_tvl_ratio != null && pool.fee_active_tvl_ratio != null) {
    factors++;
    const poolFee = pool.fee_active_tvl_ratio;
    const lessonFee = signals.fee_tvl_ratio;
    if (Math.abs(poolFee - lessonFee) / Math.max(lessonFee, 0.01) < 0.5) {
      score += 1;
    }
  }

  // Pool name similarity (prefix match)
  if (signals.pool_hint) {
    factors++;
    const poolName = (pool.name || "").toLowerCase();
    if (poolName.includes(signals.pool_hint)) score += 1;
  }

  // Strategy match
  if (signals.strategy) {
    factors++;
    if (pool.strategy === signals.strategy) {
      score += 1;
    } else {
      score += 0.2; // Small soft signal for different strategy
    }
  }

  return factors > 0 ? score / factors : 0;
}

/**
 * Score a pool candidate based on lesson history.
 *
 * @param {Object} pool - Pool candidate from getTopCandidates
 * @param {number} baseScore - Base score from screening (0-100)
 * @returns {{ score: number, modifiers: Array<{ lesson: string, delta: number }> }}
 */
export function scorePoolByLessons(pool, baseScore = 50) {
  const lessons = loadLessons();
  if (lessons.length === 0) return { score: baseScore, modifiers: [] };

  const modifiers = [];
  let totalDelta = 0;

  for (const lesson of lessons) {
    if (lesson.outcome === "neutral" || lesson.outcome === "evolution") continue;
    if (lesson.sourceType === "config_change") continue;

    const signals = parseLessonSignals(lesson.rule);
    if (!signals || signals.direction === "NEUTRAL") continue;

    const match = matchScore(pool, signals);
    if (match < 0.3) continue; // weak match, skip

    // Scale modifier by match quality and lesson confidence
    const confidence = lesson.confidence ?? 0.5;
    const weight = match * confidence;

    if (signals.direction === "GOOD") {
      const delta = 25 * weight;
      totalDelta += delta;
      modifiers.push({
        lesson: lesson.rule.slice(0, 80),
        match: Math.round(match * 100),
        delta: Math.round(delta * 100) / 100,
      });
    } else if (signals.direction === "BAD") {
      const delta = -25 * weight;
      totalDelta += delta;
      modifiers.push({
        lesson: lesson.rule.slice(0, 80),
        match: Math.round(match * 100),
        delta: Math.round(delta * 100) / 100,
      });
    }
  }

  // Clamp final score to [0, 100]
  const finalScore = Math.max(0, Math.min(100, baseScore + totalDelta));

  return {
    score: Math.round(finalScore * 100) / 100,
    base_score: baseScore,
    total_delta: Math.round(totalDelta * 100) / 100,
    modifiers: modifiers.slice(0, 5), // top 5 modifiers
  };
}

/**
 * Simplified pool scoring for inline use during screening.
 * Returns { adjustment: number (-0.5 to +0.5), matched: string }
 */
export function scorePool(pool) {
  const lessons = loadLessons();
  if (lessons.length === 0) return { adjustment: 0, matched: "no lessons" };

  let totalAdjustment = 0;
  const matched = [];

  for (const lesson of lessons) {
    if (lesson.outcome === "neutral" || lesson.outcome === "evolution") continue;
    if (lesson.sourceType === "config_change") continue;

    const signals = parseLessonSignals(lesson.rule);
    if (!signals || signals.direction === "NEUTRAL") continue;

    const match = matchScore(pool, signals);
    if (match < 0.3) continue;

    const confidence = lesson.confidence ?? 0.5;
    const weight = match * confidence;

    if (signals.direction === "GOOD") {
      totalAdjustment += 0.25 * weight;
      matched.push(`${lesson.rule.slice(0, 40)}:GOOD`);
    } else if (signals.direction === "BAD") {
      totalAdjustment -= 0.25 * weight;
      matched.push(`${lesson.rule.slice(0, 40)}:BAD`);
    }
  }

  return {
    adjustment: Math.max(-0.5, Math.min(0.5, totalAdjustment)),
    matched: matched.slice(0, 3).join("; ") || "none",
  };
}
