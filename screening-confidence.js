/**
 * Deterministic screening autopilot — confidence scoring for LLM-free deploys.
 *
 * Turns the conviction signals the SCREENER prompt already weighs (degen score,
 * smart wallets, narrative presence) into a single number so the screening cycle
 * can deploy strong candidates without an LLM round-trip (screening.llmMode).
 * Anything ambiguous — PVP conflicts, pools with deploy history, invalid
 * volatility — is flagged as a blocker and stays on the LLM path instead.
 *
 * Kept dependency-light (degenScore + config) so it is unit-testable directly.
 */
import { degenScore } from "./tools/screening.js";
import { config } from "./config.js";

const DEFAULTS = {
  minConfidence: 70,     // auto-deploy bar (degen is 0..100, so 70 = strong)
  smartWalletBonus: 20,  // mirrors opportunity.smartWalletScoreBonus semantics
  narrativeBonus: 10,    // narrative PRESENCE only — quality stays an LLM judgment
};

/**
 * Score one recon candidate. Returns the score, its breakdown (for logs and the
 * Telegram report), and `blockers` — conditions that don't cap the score but
 * disqualify the candidate from AUTO deploy because they need LLM judgment.
 *
 * @param {Object} ctx  recon context: { pool, sw, n, ti, mem }
 * @param {Object} [opts] overrides for tests: { minConfidence, smartWalletBonus, narrativeBonus, degenTargets }
 */
export function computeCandidateConfidence(ctx, opts = {}) {
  const { pool, sw, n } = ctx || {};
  if (!pool) {
    return { score: 0, degen: 0, smartWallets: [], hasNarrative: false, breakdown: [], blockers: ["missing candidate data"] };
  }

  const smartWalletBonus = opts.smartWalletBonus ?? config.screening.autoDeploySmartWalletBonus ?? DEFAULTS.smartWalletBonus;
  const narrativeBonus = opts.narrativeBonus ?? config.screening.autoDeployNarrativeBonus ?? DEFAULTS.narrativeBonus;

  const degen = degenScore(pool, opts.degenTargets ?? config.opportunity);
  const smartWallets = sw?.in_pool || [];
  const hasNarrative = !!n?.narrative;

  const breakdown = [`degen ${degen.toFixed(1)}`];
  let score = degen;
  if (smartWallets.length > 0) {
    score += smartWalletBonus;
    const names = smartWallets.map((w) => w.name || w.address?.slice(0, 4)).filter(Boolean).join(", ");
    breakdown.push(`+${smartWalletBonus} smart wallets${names ? ` (${names})` : ""}`);
  }
  if (hasNarrative) {
    score += narrativeBonus;
    breakdown.push(`+${narrativeBonus} narrative`);
  }

  const blockers = [];
  if (pool.is_pvp) blockers.push("PVP symbol conflict — needs LLM judgment");
  if (ctx.mem) blockers.push("pool has deploy history — needs LLM judgment");
  const volatility = Number(pool.volatility);
  if (!Number.isFinite(volatility) || volatility <= 0) blockers.push("invalid volatility — bins_below would be a guess");

  return {
    score: Math.round(score * 10) / 10,
    degen,
    smartWallets,
    hasNarrative,
    breakdown,
    blockers,
  };
}

/**
 * Pick the highest-confidence candidate eligible for a deterministic deploy.
 * Returns { ctx, confidence } or null. A candidate is eligible when it has no
 * blockers and its score clears the auto-deploy bar.
 */
export function pickAutoDeployCandidate(candidates, opts = {}) {
  const minConfidence = opts.minConfidence ?? config.screening.autoDeployMinConfidence ?? DEFAULTS.minConfidence;
  let best = null;
  for (const ctx of candidates || []) {
    const confidence = computeCandidateConfidence(ctx, opts);
    if (confidence.blockers.length > 0) continue;
    if (confidence.score < minConfidence) continue;
    if (!best || confidence.score > best.confidence.score) best = { ctx, confidence };
  }
  return best;
}
