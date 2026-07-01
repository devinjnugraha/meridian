import { getWalletValue } from "../lib/balance.js";
import { getOnChainPositions } from "../lib/positions.js";
import { getWalletRepo } from "../db.js";
import { log } from "../logger.js";

/** Fetch balances + on-chain positions, write one daily snapshot row. Returns the snapshot or null. */
export async function runAudit() {
  try {
    const [balances, positionsResult] = await Promise.all([
      getWalletValue(),
      getOnChainPositions().catch(() => null),
    ]);

    if (balances.error) {
      log("auditor_error", `Wallet balance fetch failed: ${balances.error}`);
      return null;
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const positions = positionsResult?.positions || [];
    const positionsUsd = positionsResult?.total_value_usd ?? 0;
    const positionsSol = balances.sol_price > 0 ? positionsUsd / balances.sol_price : 0;

    const snapshot = {
      date,
      sol: balances.sol,
      sol_price: balances.sol_price,
      wallet_usd: balances.total_usd,
      positions_usd: positionsUsd,
      positions_sol: positionsSol,
      position_count: positions.length,
      grand_total_usd: balances.total_usd + positionsUsd,
      grand_total_sol: balances.sol + positionsSol,
    };

    getWalletRepo().insert(snapshot);
    log("auditor", `Snapshot recorded: ${date} — ${balances.sol.toFixed(4)} SOL wallet + ${positions.length} positions ($${snapshot.grand_total_usd.toFixed(2)} total)`);
    return snapshot;
  } catch (error) {
    log("auditor_error", `Audit failed: ${error.message}`);
    return null;
  }
}
