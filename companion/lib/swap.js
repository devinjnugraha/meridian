import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWallet } from "./balance.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";

let _connection = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" || mint === "native" || /^So1+$/.test(mint) ||
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/** Swap tokens via Jupiter Swap V2 (order → sign → execute). Honors DRY_RUN. */
export async function swapToken({ input_mint, output_mint, amount }) {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (config.dryRun) {
    return { dry_run: true, would_swap: { input_mint, output_mint, amount }, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    let decimals = 9;
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    const orderUrl =
      `${JUPITER_SWAP_V2_API}/order` +
      `?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}` +
      `&taker=${wallet.publicKey.toString()}&slippageBps=${config.swap.slippageBps}`;
    const orderRes = await fetch(orderUrl, { headers: { "x-api-key": config.swap.apiKey } });
    if (!orderRes.ok) throw new Error(`Swap V2 order failed: ${orderRes.status} ${await orderRes.text()}`);
    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);

    const { transaction: unsignedTx, requestId } = order;
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.swap.apiKey },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    const result = await execRes.json();
    if (result.status === "Failed") throw new Error(`Swap failed on-chain: code=${result.code}`);

    log("swap", `SUCCESS tx: ${result.signature}`);
    return { success: true, tx: result.signature, input_mint, output_mint, amount_in: result.inputAmountResult, amount_out: result.outputAmountResult };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
