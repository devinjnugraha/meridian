import { log } from "../logger.js";
import { getWallet } from "./balance.js";

/**
 * Fetch the wallet's open DLMM positions on-chain (no state.json dependency).
 * Returns { wallet, position_count, positions:[{position,pool,base_mint,total_value_usd}],
 *           total_value_usd, error? }.
 * Used by the auditor (total value + count) and dust cleanup (base-mint protection set).
 */
export async function getOnChainPositions() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, position_count: 0, positions: [], total_value_usd: 0, error: "Wallet not configured" };
  }

  try {
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();
    const pools = portfolio.pools || [];

    // Per-pool PnL: gives positionAddress + unrealizedPnl.balances (USD) per position.
    const pnlMaps = await Promise.all(pools.map(p => fetchPnlForPool(p.poolAddress, walletAddress)));

    const positions = [];
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const byAddr = pnlMaps[i];
      for (const positionAddress of (pool.listPositions || [])) {
        const pnl = byAddr?.[positionAddress] || null;
        const valueUsd = pnl ? round4(parseFloat(pnl.unrealizedPnl?.balances || 0)) : null;
        positions.push({
          position: positionAddress,
          pool: pool.poolAddress,
          base_mint: pool.tokenXMint,
          total_value_usd: valueUsd,
        });
      }
    }

    const known = positions.filter(p => p.total_value_usd != null);
    const total = round4(known.reduce((s, p) => s + p.total_value_usd, 0));
    return { wallet: walletAddress, position_count: positions.length, positions, total_value_usd: total };
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.message}`);
    return { wallet: walletAddress, position_count: 0, positions: [], total_value_usd: 0, error: error.message };
  }
}

async function fetchPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const list = data.positions || data.data || [];
    const byAddress = {};
    for (const p of list) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("positions_error", `PnL fetch error for ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

function round4(n) { return Math.round(n * 10000) / 10000; }
