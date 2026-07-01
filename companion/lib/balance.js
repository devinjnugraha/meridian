import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _wallet = null;
export function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const EMPTY = (walletAddress, error) => ({
  wallet: walletAddress ?? null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error,
});

/**
 * Fetch wallet balances (SOL, USDC, all SPL tokens) with USD values via Helius.
 * Returns the same shape as main's getWalletBalances.
 */
export async function getWalletValue() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return EMPTY(null, "Wallet not configured");
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("balance_error", "HELIUS_API_KEY not set in .env");
    return EMPTY(walletAddress, "Helius API key missing");
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    const balances = data.balances || [];

    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round((solEntry?.balance || 0) * 1e6) / 1e6,
      sol_price: Math.round((solEntry?.pricePerToken || 0) * 100) / 100,
      sol_usd: Math.round((solEntry?.usdValue || 0) * 100) / 100,
      usdc: Math.round((usdcEntry?.balance || 0) * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("balance_error", error.message);
    return EMPTY(walletAddress, error.message);
  }
}
