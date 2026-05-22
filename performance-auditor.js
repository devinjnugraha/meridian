import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { getWalletRepo } from "./db.js";

export async function runAudit() {
  try {
    const [balances, positionsResult] = await Promise.all([
      getWalletBalances({ fresh: true }),
      getMyPositions({ force: true, silent: true }).catch(() => null),
    ]);

    if (balances.error) {
      log("auditor_error", `Wallet balance fetch failed: ${balances.error}`);
      return null;
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

    // Sum active LP position values (use true_usd which is always USD-denominated)
    const positions = positionsResult?.positions || [];
    const positionsUsd = positions.reduce((sum, p) => sum + (p.total_value_true_usd || 0), 0);
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

    const repo = getWalletRepo();
    repo.insert(snapshot);

    log("auditor", `Snapshot recorded: ${date} — ${balances.sol.toFixed(4)} SOL wallet + ${positions.length} positions ($${snapshot.grand_total_usd.toFixed(2)} total)`);
    return snapshot;
  } catch (error) {
    log("auditor_error", `Audit failed: ${error.message}`);
    return null;
  }
}
