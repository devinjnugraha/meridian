import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  addLiquidityToPosition,
  getTokenBalance,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, invalidateWalletCache } from "./wallet.js";
import { cleanDustTokens } from "./dust-cleanup.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, updateSwapResult } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote, getCooldownTokens } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, computeDeployAmount, computeBinsBelow } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import { getPoolHistory, getPortfolioRisk } from "./analytics.js";
import { scorePoolByLessons } from "../lesson-scorer.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, notifySwapFailed, notifyDustCleanup } from "../telegram.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Registered by index.js so trigger_cycle can invoke cycles without circular imports
let _screeningCycleFn = null;
let _managementCycleFn = null;
export function registerCycleTriggers({ screening, management }) {
  _screeningCycleFn = screening;
  _managementCycleFn = management;
}

async function handleTriggerCycle({ cycle }) {
  if (cycle === "screening") {
    if (!_screeningCycleFn) return { error: "Screening cycle not registered" };
    const result = await _screeningCycleFn({ silent: false });
    return { triggered: "screening", result };
  }
  if (cycle === "management") {
    if (!_managementCycleFn) return { error: "Management cycle not registered" };
    const result = await _managementCycleFn({ silent: false });
    return { triggered: "management", result };
  }
  return { error: `Unknown cycle: ${cycle}. Use 'screening' or 'management'.` };
}

// ─── Tool Handlers ─────────────────────────────────────────────

async function handleSetPositionNote({ position_address, instruction }) {
  const ok = setPositionInstruction(position_address, instruction || null);
  if (!ok) return { error: `Position ${position_address} not found in state` };
  return { saved: true, position: position_address, instruction: instruction || null };
}

async function handleSelfUpdate() {
  try {
    const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (result.includes("Already up to date")) {
      return { success: true, updated: false, message: "Already up to date — no restart needed." };
    }
    // Delay restart so this tool response (and Telegram message) gets sent first
    setTimeout(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "inherit",
        cwd: process.cwd(),
      });
      child.unref();
      process.exit(0);
    }, 3000);
    return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleGetRecentDecisions({ limit } = {}) {
  return { decisions: getRecentDecisions(limit || 6) };
}

async function handleRebalancePosition({ position_address, new_lower_bin, new_upper_bin }) {
  const tracked = getTrackedPosition(position_address);
  if (!tracked) return { error: `Position ${position_address} not found in state` };
  if (tracked.closed) return { error: `Position ${position_address} is already closed` };

  // Close the position first (via executeTool to get notifications, auto-swap, cooldown checks)
  const closeResult = await executeTool("close_position", { position_address, reason: "rebalance" });
  if (!closeResult.success && closeResult.error) {
    return { error: `Close failed during rebalance: ${closeResult.error}` };
  }

  // Determine deploy amount from returned SOL
  const solReceived = closeResult.sol_received ?? closeResult.amount_y ?? tracked.amount_sol ?? 0;
  if (solReceived <= 0) {
    return { error: "Rebalance: closed position but no SOL returned to redeploy", close_result: closeResult };
  }

  // Redeploy with new bin range
  const deployResult = await deployPosition({
    pool_address: tracked.pool,
    amount_y: solReceived,
    strategy: tracked.strategy || "bid_ask",
    bins_below: Math.max(0, new_lower_bin),
    bins_above: Math.max(0, new_upper_bin),
    pool_name: tracked.pool_name,
    bin_step: tracked.bin_step,
    volatility: tracked.volatility,
  });

  if (deployResult.error) {
    return { error: `Redeploy failed after close: ${deployResult.error}`, close_result: closeResult };
  }

  log("executor", `Rebalanced ${position_address} → ${deployResult.position} (bins ${new_lower_bin}-${new_upper_bin})`);
  return {
    success: true,
    action: "rebalance",
    old_position: position_address,
    new_position: deployResult.position,
    pool: tracked.pool,
    sol_deployed: solReceived,
    new_bins: `${new_lower_bin}-${new_upper_bin}`,
    close_txs: closeResult.txs || closeResult.close_txs,
    deploy_txs: deployResult.txs,
  };
}

async function handleCompoundFees({ position_address }) {
  // Claim fees then auto-deploy to best pool
  const claimResult = await claimFees({ position_address });
  if (claimResult.error) return { error: `Claim failed: ${claimResult.error}` };

  // Get wallet balance after claim (fresh — balance changed on-chain)
  const balances = await getWalletBalances({ fresh: true });
  const deployAmount = computeDeployAmount(balances.sol);

  if (deployAmount < (config.management.deployAmountSol ?? 0.1)) {
    return {
      success: true,
      action: "claim_only",
      claimed: claimResult,
      note: "Insufficient SOL to deploy after claim — fees claimed but not redeployed",
    };
  }

  // Get best candidate
  const candidates = await getTopCandidates({ limit: 3 });
  const poolList = candidates?.candidates || candidates?.pools || [];
  if (!poolList.length) {
    return {
      success: true,
      action: "claim_only",
      claimed: claimResult,
      note: "No candidates available for auto-deploy",
    };
  }

  // Score candidates with lesson scorer
  const scored = poolList.map(p => ({
    pool: p,
    lessonScore: scorePoolByLessons(p, p.score ?? 50),
  })).sort((a, b) => b.lessonScore.score - a.lessonScore.score);

  const best = scored[0].pool;
  await getActiveBin({ pool_address: best.pool });

  const deployResult = await deployPosition({
    pool_address: best.pool,
    amount_y: deployAmount,
    strategy: config.strategy?.strategy || "bid_ask",
    bins_below: computeBinsBelow(best.volatility || 0),
    bins_above: 0,
    pool_name: best.name,
    base_mint: best.base?.mint,
    bin_step: best.bin_step,
    volatility: best.volatility,
  });

  if (deployResult.error) {
    return { success: true, action: "claim_only", claimed: claimResult, deploy_error: deployResult.error };
  }

  log("executor", `Compound: claimed from ${position_address}, deployed ${deployAmount} SOL to ${best.name}`);
  return {
    success: true,
    action: "compound",
    claimed: claimResult,
    new_position: deployResult.position,
    deployed_to: best.name,
    deployed_pool: best.pool,
    amount_sol: deployAmount,
    deploy_txs: deployResult.txs,
  };
}

function handleAddLesson({ rule, tags, pinned, role }) {
  addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
  return { saved: true, rule, pinned: !!pinned, role: role || "all" };
}

function handlePinLesson({ id }) {
  return pinLesson(id);
}

function handleUnpinLesson({ id }) {
  return unpinLesson(id);
}

function handleListLessons({ role, pinned, tag, limit } = {}) {
  return listLessons({ role, pinned, tag, limit });
}

function handleClearLessons({ mode, keyword }) {
  if (mode === "all") {
    const n = clearAllLessons();
    log("lessons", `Cleared all ${n} lessons`);
    return { cleared: n, mode: "all" };
  }
  if (mode === "performance") {
    const n = clearPerformance();
    log("lessons", `Cleared ${n} performance records`);
    return { cleared: n, mode: "performance" };
  }
  if (mode === "keyword") {
    if (!keyword) return { error: "keyword required for mode=keyword" };
    const n = removeLessonsByKeyword(keyword);
    log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
    return { cleared: n, mode: "keyword", keyword };
  }
  return { error: "invalid mode" };
}

// Shared flat key → [section, field] mapping for get/update config tools
const CONFIG_MAP = {
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minQuoteOrganic: ["screening", "minQuoteOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  useDiscordSignals: ["screening", "useDiscordSignals"],
  discordSignalMode: ["screening", "discordSignalMode"],
  avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
  blockPvpSymbols: ["screening", "blockPvpSymbols"],
  maxBundlePct: ["screening", "maxBundlePct"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  allowedLaunchpads: ["screening", "allowedLaunchpads"],
  blockedLaunchpads: ["screening", "blockedLaunchpads"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  athFilterPct: ["screening", "athFilterPct"],
  minFeePerTvl24h: ["management", "minFeePerTvl24h"],
  minClaimAmount: ["management", "minClaimAmount"],
  autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeBinsToCloseBelow: ["management", "outOfRangeBinsToCloseBelow"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
  oorCooldownHours: ["management", "oorCooldownHours"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitPct: ["management", "takeProfitPct"],
  takeProfitFeePct: ["management", "takeProfitPct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
  dynamicILStop: ["management", "dynamicILStop"],
  ilRecoveryMaxDays: ["management", "ilRecoveryMaxDays"],
  ilStopMinPct: ["management", "ilStopMinPct"],
  ilStopMinAgeMinutes: ["management", "ilStopMinAgeMinutes"],
  solMode: ["management", "solMode"],
  minSolToOpen: ["management", "minSolToOpen"],
  deployAmountSol: ["management", "deployAmountSol"],
  gasReserve: ["management", "gasReserve"],
  positionSizePct: ["management", "positionSizePct"],
  minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
  dustThresholdUsd: ["management", "dustThresholdUsd"],
  feeRateDecayEnabled: ["management", "feeRateDecayEnabled"],
  feeRateDropPct: ["management", "feeRateDropPct"],
  minFeesBeforeFeeRateExit: ["management", "minFeesBeforeFeeRateExit"],
  volumeDecayEnabled: ["management", "volumeDecayEnabled"],
  volumeDecayPct: ["management", "volumeDecayPct"],
  minFeesBeforeExit: ["management", "minFeesBeforeExit"],
  recompoundEnabled: ["management", "recompoundEnabled"],
  recompoundCooldownMinutes: ["management", "recompoundCooldownMinutes"],
  silentMode: ["management", "silentMode"],
  summarizePerformanceNotificationHrs: ["management", "summarizePerformanceNotificationHrs"],
  maxPositions: ["risk", "maxPositions"],
  maxDeployAmount: ["risk", "maxDeployAmount"],
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
  dustCleanupIntervalHours: ["schedule", "dustCleanupIntervalHours"],
  pnlPollIntervalSec: ["schedule", "pnlPollIntervalSec"],
  defaultModel: ["llm", "defaultModel"],
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  temperature: ["llm", "temperature"],
  maxTokens: ["llm", "maxTokens"],
  maxSteps: ["llm", "maxSteps"],
  strategy: ["strategy", "strategy"],
  binsBelow: ["strategy", "binsBelow"],
  hiveMindUrl: ["hiveMind", "url"],
  hiveMindApiKey: ["hiveMind", "apiKey"],
  agentId: ["hiveMind", "agentId"],
  hiveMindPullMode: ["hiveMind", "pullMode"],
  darwinEnabled: ["darwin", "enabled"],
  darwinWindowDays: ["darwin", "windowDays"],
  darwinRecalcEvery: ["darwin", "recalcEvery"],
  darwinBoost: ["darwin", "boostFactor"],
  darwinDecay: ["darwin", "decayFactor"],
  darwinFloor: ["darwin", "weightFloor"],
  darwinCeiling: ["darwin", "weightCeiling"],
  darwinMinSamples: ["darwin", "minSamples"],
};

function handleGetConfig() {
  const result = {};
  for (const [flatKey, [section, field]] of Object.entries(CONFIG_MAP)) {
    result[flatKey] = config[section]?.[field];
  }
  return result;
}

function handleUpdateConfig({ changes, reason = "" }) {
  const applied = {};
  const unknown = [];

  const CONFIG_MAP_LOWER = Object.fromEntries(
    Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
  );

  for (const [key, val] of Object.entries(changes)) {
    const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
    if (!match) { unknown.push(key); continue; }
    applied[match[0]] = val;
  }

  if (Object.keys(applied).length === 0) {
    log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
    return { success: false, unknown, reason };
  }

  // Apply to live config immediately
  for (const [key, val] of Object.entries(applied)) {
    const [section, field] = CONFIG_MAP[key];
    const before = config[section][field];
    config[section][field] = val;
    log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
  }

  // Persist to user-config.json
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
  }
  Object.assign(userConfig, applied);
  userConfig._lastAgentTune = new Date().toISOString();
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Restart cron jobs if intervals changed
  const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.dustCleanupIntervalHours != null || applied.summarizePerformanceNotificationHrs != null;
  if (intervalChanged && _cronRestarter) {
    _cronRestarter();
    log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
  }

  // Save as a lesson — but skip ephemeral per-deploy interval changes
  // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
  //  the rule is already in the system prompt, storing it 75+ times is pure noise)
  const lessonsKeys = Object.keys(applied).filter(
    k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
  );
  if (lessonsKeys.length > 0) {
    const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
    addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
  }

  log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
  return { success: true, applied, unknown, reason };
}

// ─── Tool Map ──────────────────────────────────────────────────

const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  skip_deploy: async (args) => {
    log("screener", `Screening skip: ${args.reason}`);
    return { skipped: true, reason: args.reason };
  },
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  add_liquidity_to_position: addLiquidityToPosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  clean_dust_tokens: cleanDustTokens,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: handleSetPositionNote,
  self_update: handleSelfUpdate,
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: handleGetRecentDecisions,
  rebalance_position: handleRebalancePosition,
  compound_fees: handleCompoundFees,
  get_pool_history: getPoolHistory,
  get_portfolio_risk: getPortfolioRisk,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  get_cooldown_tokens: getCooldownTokens,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: handleAddLesson,
  pin_lesson: handlePinLesson,
  unpin_lesson: handleUnpinLesson,
  list_lessons: handleListLessons,
  clear_lessons: handleClearLessons,
  update_config: handleUpdateConfig,
  get_config: handleGetConfig,
  trigger_cycle: handleTriggerCycle,
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "rebalance_position",
  "compound_fees",
  "add_liquidity_to_position",
  "clean_dust_tokens",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args, meta = {}) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
      ...(meta.agentRole && { agentRole: meta.agentRole }),
      ...(meta.source && { source: meta.source }),
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        invalidateWalletCache();
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        invalidateWalletCache();
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        // Dynamic schedule: adjust management interval based on pool volatility
        const vol = args.volatility ?? 0;
        let targetInterval;
        if (vol >= 5) targetInterval = 3;
        else if (vol >= 2) targetInterval = 5;
        else targetInterval = 10;
        if (targetInterval !== config.schedule.managementIntervalMin) {
          config.schedule.managementIntervalMin = targetInterval;
          let uc = {};
          if (fs.existsSync(USER_CONFIG_PATH)) try { uc = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* */ }
          uc.managementIntervalMin = targetInterval;
          fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(uc, null, 2));
          if (_cronRestarter) _cronRestarter();
          log("executor", `Dynamic schedule: managementIntervalMin → ${targetInterval}m (vol=${vol})`);
          result.schedule_note = `Management interval auto-set to ${targetInterval}m based on volatility ${vol}`;
        }
      } else if (name === "close_position") {
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            // Use direct RPC token balance as primary source — Helius API can lag
            // and miss freshly received tokens, causing silent swap skip (IL exposure).
            await new Promise(r => setTimeout(r, 5000)); // let RPC settle
            const rpcBalance = await getTokenBalance(result.base_mint);
            if (rpcBalance > 0) {
              log("executor", `Auto-swapping ${result.base_mint.slice(0, 8)} (${rpcBalance} tokens, RPC balance) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: rpcBalance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
              invalidateWalletCache();
              // Persist actual swap result to performance & pool-memory
              if (result.position && swapResult?.amount_out) {
                updateSwapResult(result.position, {
                  sol_received: swapResult.amount_out,
                  amount_in: swapResult.amount_in,
                  tx: swapResult.tx,
                }).catch(e => log("executor_warn", `updateSwapResult failed: ${e.message}`));
              }
            } else {
              log("executor_warn", `Auto-swap skipped: no base token balance found for ${result.base_mint.slice(0, 8)} after close`);
              // notifySwapFailed({ pair: result.pool_name || args.position_address?.slice(0, 8), reason: `Token not found in wallet after close (mint: ${result.base_mint.slice(0, 8)})` }).catch(() => {});
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
            notifySwapFailed({ pair: result.pool_name || args.position_address?.slice(0, 8), reason: e.message }).catch(() => {});
          }
        }
        // Send Telegram notification after swap so we can include actual SOL amounts
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          reason: args.reason || null,
          initialSol: result.initial_sol || 0,
          withdrawnSol: result.withdrawn_sol || 0,
          feesSol: result.fees_sol || 0,
          solReceived: result.sol_received || null,
        }).catch(() => {});
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({ fresh: true });
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      } else if (name === "clean_dust_tokens") {
        notifyDustCleanup(result).catch(() => {});
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance (fresh — deploying changes balance)
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances({ fresh: true });
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
