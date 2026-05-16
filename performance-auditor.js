import { getWalletBalances } from "./tools/wallet.js";
import { log } from "./logger.js";
import MeridianDB from "./db.js";

export async function runAudit() {
  try {
    const balances = await getWalletBalances({ fresh: true });

    if (balances.error) {
      log("auditor_error", `Wallet balance fetch failed: ${balances.error}`);
      return null;
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

    const snapshot = {
      date,
      sol: balances.sol,
      sol_price: balances.sol_price,
      sol_usd: balances.sol_usd,
      total_usd: balances.total_usd,
    };

    const db = MeridianDB.getInstance();
    db.insertWalletSnapshot(snapshot);

    log("auditor", `Snapshot recorded: ${date} — ${balances.sol.toFixed(4)} SOL ($${balances.total_usd.toFixed(2)})`);
    return snapshot;
  } catch (error) {
    log("auditor_error", `Audit failed: ${error.message}`);
    return null;
  }
}
