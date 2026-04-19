import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getWalletBalances, swapToken, normalizeMint } from "./wallet.js";
import { getTrackedPositions } from "../state.js";
import { appendDecision } from "../decision-log.js";

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

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const RENT_PER_ATA = 0.00207408; // SOL reclaimed per closed ATA (rent-exempt minimum)
const BATCH_SIZE = 20; // close instructions per transaction
const SWAP_DELAY_MS = 2000; // delay between swaps to avoid rate limiting

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clean up dust tokens: swap low-value tokens to SOL, then close empty ATAs to reclaim rent.
 *
 * @param {Object} opts
 * @param {number} [opts.maxUsdValue] - Max USD value to treat as dust (default: config.management.dustThresholdUsd or 0.10)
 * @returns {Object} Summary report
 */
export async function cleanDustTokens({ maxUsdValue } = {}) {
    const threshold = maxUsdValue ?? config.management.dustThresholdUsd ?? 0.1;
    const isDryRun = process.env.DRY_RUN === "true";
    const wallet = getWallet();
    const connection = getConnection();

    log("dust_cleanup", `Starting dust cleanup (threshold: $${threshold}, dry_run: ${isDryRun})`);

    const result = {
        success: true,
        dry_run: isDryRun,
        threshold_usd: threshold,
        swapped: [],
        swap_failed: [],
        accounts_closed: 0,
        rent_reclaimed_sol: 0,
        close_txs: [],
        total_sol_gained: 0,
        skipped_protected: [],
        skipped_active_position: [],
    };

    try {
        // ─── 1. Fetch balances (USD values) from Helius ────────────
        const balances = await getWalletBalances();
        if (balances.error) {
            return { ...result, success: false, error: `Balance fetch failed: ${balances.error}` };
        }

        // Build mint → { symbol, balance, usd } map from Helius data
        const heliusMap = new Map();
        for (const t of balances.tokens) {
            heliusMap.set(t.mint, { symbol: t.symbol, balance: t.balance, usd: t.usd });
        }

        // ─── 2. Fetch all token accounts via RPC (need ATA addresses) ──
        const [standardAccounts, token2022Accounts] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
            connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);

        // Build mint → { ataAddress, mint, balance, programId } map
        const ataMap = new Map();
        for (const { pubkey, account } of [...standardAccounts.value, ...token2022Accounts.value]) {
            const info = account.data.parsed.info;
            const mint = info.mint;
            const balance = info.tokenAmount?.uiAmount ?? 0;
            const programId = account.owner.toString();
            ataMap.set(mint, { ataAddress: pubkey, mint, balance, programId });
        }

        // ─── 3. Get active positions — protect their base tokens ────
        const openPositions = getTrackedPositions(true);
        const activeMints = new Set(openPositions.map((p) => p.base_mint).filter(Boolean));

        // ─── 4. Protected mints ────────────────────────────────────
        const protectedMints = new Set([config.tokens.SOL, config.tokens.USDC, config.tokens.USDT]);

        // ─── 5. Categorize tokens ──────────────────────────────────
        const swapCandidates = [];
        const closeCandidates = [];

        for (const [mint, ata] of ataMap) {
            // Skip protected mints
            if (protectedMints.has(mint)) {
                const h = heliusMap.get(mint);
                result.skipped_protected.push({ mint, symbol: h?.symbol ?? mint.slice(0, 8), reason: "protected" });
                continue;
            }

            // Skip tokens with active positions
            if (activeMints.has(mint)) {
                result.skipped_active_position.push({ mint });
                continue;
            }

            const h = heliusMap.get(mint);
            const usdValue = h?.usd ?? null;
            const symbol = h?.symbol ?? mint.slice(0, 8);
            const balance = ata.balance;

            if (balance > 0 && (usdValue === null || usdValue < threshold)) {
                swapCandidates.push({ ...ata, symbol, usdValue, heliusBalance: h?.balance ?? balance });
            } else if (balance === 0) {
                closeCandidates.push({ ...ata, symbol });
            }
        }

        log("dust_cleanup", `Found ${swapCandidates.length} swap candidates, ${closeCandidates.length} close candidates`);

        // ─── DRY RUN: report only ──────────────────────────────────
        if (isDryRun) {
            return {
                ...result,
                swap_candidates: swapCandidates.map((c) => ({ mint: c.mint, symbol: c.symbol, balance: c.balance, usd: c.usdValue })),
                close_candidates: closeCandidates.map((c) => ({ mint: c.mint, symbol: c.symbol })),
                message: "DRY RUN — no transactions sent",
            };
        }

        // ─── 6. Check SOL balance for gas ──────────────────────────
        const solBalance = balances.sol;
        const gasReserve = config.management.gasReserve ?? 0.2;
        if (solBalance < gasReserve) {
            log("dust_cleanup", `SOL balance (${solBalance}) below gas reserve (${gasReserve}), skipping`);
            return { ...result, success: false, error: `SOL balance ${solBalance} below gas reserve ${gasReserve}` };
        }

        // ─── 7. Swap phase (sequential) ────────────────────────────
        let totalSolFromSwaps = 0;

        for (const candidate of swapCandidates) {
            try {
                log("dust_cleanup", `Swapping ${candidate.heliusBalance} ${candidate.symbol} ($${candidate.usdValue ?? 0}) → SOL`);
                const swapResult = await swapToken({
                    input_mint: candidate.mint,
                    output_mint: "SOL",
                    amount: candidate.heliusBalance,
                });

                if (swapResult.success === false) {
                    throw new Error(swapResult.error || "Swap returned unsuccessful");
                }

                if (swapResult.dry_run) {
                    result.swapped.push({
                        mint: candidate.mint,
                        symbol: candidate.symbol,
                        amount: candidate.heliusBalance,
                        usd_value: candidate.usdValue,
                        tx: null,
                        dry_run: true,
                    });
                    continue;
                }

                result.swapped.push({
                    mint: candidate.mint,
                    symbol: candidate.symbol,
                    amount: candidate.heliusBalance,
                    usd_value: candidate.usdValue,
                    tx: swapResult.tx,
                });

                // After swap, check if account is now empty — add to close candidates
                await sleep(1000);
                const postBalance = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                    mint: new PublicKey(candidate.mint),
                });
                const postInfo = postBalance.value[0]?.account?.data?.parsed?.info;
                const remaining = postInfo?.tokenAmount?.uiAmount ?? 0;
                if (remaining === 0 && postBalance.value[0]) {
                    closeCandidates.push({
                        mint: candidate.mint,
                        symbol: candidate.symbol,
                        ataAddress: postBalance.value[0].pubkey,
                        programId: candidate.programId,
                    });
                }

                log("dust_cleanup", `Swapped ${candidate.symbol} successfully (tx: ${swapResult.tx})`);
                await sleep(SWAP_DELAY_MS);
            } catch (error) {
                log("dust_cleanup_error", `Failed to swap ${candidate.symbol}: ${error.message}`);
                result.swap_failed.push({ mint: candidate.mint, symbol: candidate.symbol, error: error.message });
            }
        }

        // ─── 8. Close phase (batched) ──────────────────────────────
        if (closeCandidates.length > 0) {
            // Separate by program ID for correct instruction construction
            const byProgram = new Map();
            for (const c of closeCandidates) {
                const pid = c.programId ?? TOKEN_PROGRAM_ID.toString();
                if (!byProgram.has(pid)) byProgram.set(pid, []);
                byProgram.get(pid).push(c);
            }

            for (const [programIdStr, accounts] of byProgram) {
                const tokenProgramId = new PublicKey(programIdStr);

                // Batch into transactions of BATCH_SIZE
                for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
                    const batch = accounts.slice(i, i + BATCH_SIZE);
                    const tx = new Transaction();

                    for (const acct of batch) {
                        tx.add(
                            createCloseAccountInstruction(
                                acct.ataAddress, // account to close
                                wallet.publicKey, // destination for rent refund
                                wallet.publicKey, // owner
                                [], // multiSigners
                                tokenProgramId, // token program
                            ),
                        );
                    }

                    try {
                        const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
                        result.close_txs.push(sig);
                        result.accounts_closed += batch.length;
                        log("dust_cleanup", `Closed batch of ${batch.length} accounts (tx: ${sig})`);
                    } catch (error) {
                        log("dust_cleanup_error", `Failed to close batch: ${error.message}`);
                        // If batch fails, try individual closes
                        for (const acct of batch) {
                            try {
                                const singleTx = new Transaction();
                                singleTx.add(
                                    createCloseAccountInstruction(acct.ataAddress, wallet.publicKey, wallet.publicKey, [], tokenProgramId),
                                );
                                const sig = await sendAndConfirmTransaction(connection, singleTx, [wallet], { commitment: "confirmed" });
                                result.close_txs.push(sig);
                                result.accounts_closed++;
                            } catch {
                                // skip individual failures
                            }
                        }
                    }
                }
            }
        }

        // ─── 9. Calculate totals ───────────────────────────────────
        result.rent_reclaimed_sol = parseFloat((result.accounts_closed * RENT_PER_ATA).toFixed(6));
        result.total_sol_gained = parseFloat(result.rent_reclaimed_sol.toFixed(6));

        log(
            "dust_cleanup",
            `Complete: ${result.swapped.length} swapped, ${result.swap_failed.length} failed, ` +
                `${result.accounts_closed} accounts closed, ${result.total_sol_gained} SOL reclaimed`,
        );

        appendDecision({
            type: "dust_cleanup",
            actor: "MANAGER",
            summary: `Dust cleanup: ${result.swapped.length} swapped, ${result.accounts_closed} accounts closed, ${result.total_sol_gained.toFixed(6)} SOL reclaimed`,
            reason: result.swap_failed.length
                ? `${result.swap_failed.length} swap(s) failed: ${result.swap_failed.map((s) => s.symbol).join(", ")}`
                : "All swaps succeeded",
            metrics: {
                threshold_usd: threshold,
                swapped_count: result.swapped.length,
                swap_failed_count: result.swap_failed.length,
                accounts_closed: result.accounts_closed,
                rent_reclaimed_sol: result.rent_reclaimed_sol,
                total_sol_gained: result.total_sol_gained,
            },
        });

        return result;
    } catch (error) {
        log("dust_cleanup_error", `Fatal: ${error.message}`);
        return { ...result, success: false, error: error.message };
    }
}
