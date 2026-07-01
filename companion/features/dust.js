import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWalletValue } from "../lib/balance.js";
import { getOnChainPositions } from "../lib/positions.js";
import { swapToken } from "../lib/swap.js";
import { sendMessage } from "../lib/telegram.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const RENT_PER_ATA = 0.00207408; // SOL reclaimed per closed ATA (rent-exempt minimum)

let _connection = null;
let _wallet = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}
function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Sweep dust tokens → SOL and close empty ATAs to reclaim rent.
 * Protection set (tokens backing open positions) is derived ON-CHAIN (no state.json).
 */
export async function cleanDust() {
  const threshold = config.dust.thresholdUsd;
  const isDryRun = config.dryRun;
  const wallet = getWallet();
  const connection = getConnection();

  log("dust_cleanup", `Starting dust cleanup (threshold: $${threshold}, dry_run: ${isDryRun})`);

  const result = {
    success: true, dry_run: isDryRun, threshold_usd: threshold,
    swapped: [], swap_failed: [], accounts_closed: 0, rent_reclaimed_sol: 0,
    total_sol_gained: 0, skipped_protected: [], skipped_active_position: [],
  };

  try {
    const balances = await getWalletValue();
    if (balances.error) return { ...result, success: false, error: `Balance fetch failed: ${balances.error}` };

    const heliusMap = new Map();
    for (const t of balances.tokens) heliusMap.set(t.mint, { symbol: t.symbol, balance: t.balance, usd: t.usd });

    const [standardAccounts, token2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const ataMap = new Map();
    for (const { pubkey, account } of [...standardAccounts.value, ...token2022Accounts.value]) {
      const info = account.data.parsed.info;
      ataMap.set(info.mint, { ataAddress: pubkey, mint: info.mint, balance: info.tokenAmount?.uiAmount ?? 0, programId: account.owner.toString() });
    }

    // Protection set: base mints of OPEN positions (on-chain) — never sweep these.
    const positionsResult = await getOnChainPositions().catch(() => ({ positions: [] }));
    const activeMints = new Set(positionsResult.positions.map(p => p.base_mint).filter(Boolean));
    const protectedMints = new Set([config.tokens.SOL, config.tokens.USDC, config.tokens.USDT]);

    const swapCandidates = [];
    const closeCandidates = [];

    for (const [mint, ata] of ataMap) {
      if (protectedMints.has(mint)) { result.skipped_protected.push({ mint }); continue; }
      if (activeMints.has(mint)) { result.skipped_active_position.push({ mint }); continue; }
      const h = heliusMap.get(mint);
      const usdValue = h?.usd ?? null;
      const symbol = h?.symbol ?? mint.slice(0, 8);
      if (ata.balance > 0 && (usdValue === null || usdValue < threshold)) {
        swapCandidates.push({ ...ata, symbol, usdValue, heliusBalance: h?.balance ?? ata.balance });
      } else if (ata.balance === 0) {
        closeCandidates.push({ ...ata, symbol });
      }
    }

    log("dust_cleanup", `Found ${swapCandidates.length} swap candidates, ${closeCandidates.length} close candidates`);

    if (isDryRun) {
      const summary = `🧹 <b>Dust Cleanup</b> (DRY RUN)\n────────────────\nSwap candidates: ${swapCandidates.length}\nClose candidates: ${closeCandidates.length}\nProtected (active positions): ${result.skipped_active_position.length}\nNo transactions sent.`;
      await sendMessage(summary).catch(() => {});
      return { ...result, swap_candidates: swapCandidates, close_candidates: closeCandidates, message: "DRY RUN — no transactions sent" };
    }

    const solBalance = balances.sol;
    if (solBalance < config.gasReserve) {
      log("dust_cleanup", `SOL balance (${solBalance}) below gas reserve (${config.gasReserve}), skipping`);
      return { ...result, success: false, error: `SOL balance ${solBalance} below gas reserve ${config.gasReserve}` };
    }

    // Swap phase (sequential)
    for (const candidate of swapCandidates) {
      try {
        log("dust_cleanup", `Swapping ${candidate.heliusBalance} ${candidate.symbol} ($${candidate.usdValue ?? 0}) → SOL`);
        const swapResult = await swapToken({ input_mint: candidate.mint, output_mint: "SOL", amount: candidate.heliusBalance });
        if (swapResult.success === false) throw new Error(swapResult.error || "Swap returned unsuccessful");
        result.swapped.push({ mint: candidate.mint, symbol: candidate.symbol, amount: candidate.heliusBalance, usd_value: candidate.usdValue, tx: swapResult.tx ?? null, dry_run: !!swapResult.dry_run });
        await sleep(1000);
        const post = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(candidate.mint) });
        const remaining = post.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (remaining === 0 && post.value[0]) {
          closeCandidates.push({ mint: candidate.mint, symbol: candidate.symbol, ataAddress: post.value[0].pubkey, programId: candidate.programId });
        }
        await sleep(config.dust.swapDelayMs);
      } catch (error) {
        log("dust_cleanup_error", `Failed to swap ${candidate.symbol}: ${error.message}`);
        result.swap_failed.push({ mint: candidate.mint, symbol: candidate.symbol, error: error.message });
      }
    }

    // Close phase (batched)
    if (closeCandidates.length > 0) {
      const byProgram = new Map();
      for (const c of closeCandidates) {
        const pid = c.programId ?? TOKEN_PROGRAM_ID.toString();
        if (!byProgram.has(pid)) byProgram.set(pid, []);
        byProgram.get(pid).push(c);
      }
      for (const [programIdStr, accounts] of byProgram) {
        const tokenProgramId = new PublicKey(programIdStr);
        for (let i = 0; i < accounts.length; i += config.dust.batchSize) {
          const batch = accounts.slice(i, i + config.dust.batchSize);
          const tx = new Transaction();
          for (const acct of batch) {
            tx.add(createCloseAccountInstruction(acct.ataAddress, wallet.publicKey, wallet.publicKey, [], tokenProgramId));
          }
          try {
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
            result.accounts_closed += batch.length;
            log("dust_cleanup", `Closed batch of ${batch.length} accounts (tx: ${sig})`);
          } catch (error) {
            log("dust_cleanup_error", `Batch close failed: ${error.message} — retrying individually`);
            for (const acct of batch) {
              try {
                const single = new Transaction();
                single.add(createCloseAccountInstruction(acct.ataAddress, wallet.publicKey, wallet.publicKey, [], tokenProgramId));
                await sendAndConfirmTransaction(connection, single, [wallet], { commitment: "confirmed" });
                result.accounts_closed++;
              } catch {
                /* skip individual failures */
              }
            }
          }
        }
      }
    }

    result.rent_reclaimed_sol = parseFloat((result.accounts_closed * RENT_PER_ATA).toFixed(6));
    result.total_sol_gained = result.rent_reclaimed_sol;

    const summary =
      `🧹 <b>Dust Cleanup Complete</b>\n────────────────\n` +
      `🔁 Swapped: ${result.swapped.length}  ·  ❌ Failed: ${result.swap_failed.length}\n` +
      `🚪 ATAs closed: ${result.accounts_closed}\n` +
      `💎 Rent reclaimed: ${result.total_sol_gained.toFixed(6)} SOL\n` +
      `🛡 Protected (active positions): ${result.skipped_active_position.length}`;
    await sendMessage(summary).catch(() => {});

    log("dust_cleanup", `Complete: ${result.swapped.length} swapped, ${result.accounts_closed} closed, ${result.total_sol_gained} SOL reclaimed`);
    return result;
  } catch (error) {
    log("dust_cleanup_error", `Fatal: ${error.message}`);
    return { ...result, success: false, error: error.message };
  }
}
