import { log } from "../logger.js";

const DEXSCREENER_API = "https://api.dexscreener.com/tokens/v1/solana";

/**
 * Fetch DexScreener pair data for a batch of token mints (max 30 per call).
 * Returns a map: mintAddress → best pair object.
 */
export async function fetchTokenPairs(mints) {
  if (!mints || mints.length === 0) return new Map();

  const mintList = mints.filter(Boolean);
  if (mintList.length === 0) return new Map();

  const url = `${DEXSCREENER_API}/${mintList.join(",")}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      log("dexscreener", `API error ${res.status} for ${mintList.length} mints`);
      return new Map();
    }
    const pairs = await res.json();

    const map = new Map();
    for (const pair of pairs ?? []) {
      const mint = pair.baseToken?.address;
      if (mint && !map.has(mint)) {
        map.set(mint, pair);
      }
    }
    return map;
  } catch (err) {
    log("dexscreener", `Fetch failed: ${err.message}`);
    return new Map();
  }
}

