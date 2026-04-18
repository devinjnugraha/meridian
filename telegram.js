import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
    String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
);

let chatId = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
    try {
        if (fs.existsSync(USER_CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
            if (cfg.telegramChatId) chatId = cfg.telegramChatId;
        }
    } catch {
        /**/
    }
}

function saveChatId(id) {
    try {
        let cfg = fs.existsSync(USER_CONFIG_PATH) ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) : {};
        cfg.telegramChatId = id;
        fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (e) {
        log("telegram_error", `Failed to persist chatId: ${e.message}`);
    }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
    const incomingChatId = String(msg.chat?.id || "");
    const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
    const chatType = msg.chat?.type || "unknown";

    if (!chatId) {
        if (!_warnedMissingChatId) {
            log(
                "telegram_warn",
                "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.",
            );
            _warnedMissingChatId = true;
        }
        return false;
    }

    if (incomingChatId !== chatId) return false;

    if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
        if (!_warnedMissingAllowedUsers) {
            log(
                "telegram_warn",
                "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.",
            );
            _warnedMissingAllowedUsers = true;
        }
        return false;
    }

    if (ALLOWED_USER_IDS.size > 0) {
        if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
    }

    return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
    return !!TOKEN;
}

async function postTelegram(method, body) {
    if (!TOKEN || !chatId) return null;
    try {
        const res = await fetch(`${BASE}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, ...body }),
        });
        if (!res.ok) {
            const err = await res.text();
            log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        log("telegram_error", `${method} failed: ${e.message}`);
        return null;
    }
}

/**
 * Lightweight markdown → Telegram HTML converter.
 * Handles bold, italic, inline code, code blocks, and bullet lists.
 * Falls back to plain text if HTML parsing fails on Telegram's side.
 */
function mdToHtml(md) {
    if (!md) return "";
    let html = md
        // Code blocks: ```lang\n...\n``` → <pre>...</pre>
        .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre>$1</pre>")
        // Inline code: `...` → <code>...</code>
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        // Bold: **...** or __...__ → <b>...</b>
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/__(.+?)__/g, "<b>$1</b>")
        // Italic: *...* or _..._ → <i>...</i>  (avoid matching within words)
        .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>")
        .replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
    // Escape raw HTML characters outside tags
    html = html
        .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#39;)/g, "&amp;")
        .replace(/<(?!\/?(b|i|u|s|pre|code|a|br|strong|em|p|ol|ul|li))([^>]*>)/g, "&lt;$1");
    return html;
}

export async function sendMessage(text) {
    if (!TOKEN || !chatId) return;
    return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html) {
    if (!TOKEN || !chatId) return;
    return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function sendMd(md) {
    if (!TOKEN || !chatId) return;
    const html = mdToHtml(md);
    const res = await postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
    if (!res?.ok) return sendMessage(md);
    return res;
}

export async function editMessageHTML(html, messageId) {
    if (!TOKEN || !chatId || !messageId) return null;
    return postTelegram("editMessageText", {
        message_id: messageId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
    });
}

export async function editMessage(text, messageId) {
    if (!TOKEN || !chatId || !messageId) return null;
    return postTelegram("editMessageText", {
        message_id: messageId,
        text: String(text).slice(0, 4096),
    });
}

export function hasActiveLiveMessage() {
    return _liveMessageDepth > 0;
}

function createTypingIndicator() {
    if (!TOKEN || !chatId) {
        return { stop() {} };
    }

    let stopped = false;
    let timer = null;

    async function tick() {
        if (stopped) return;
        await postTelegram("sendChatAction", { action: "typing" });
        timer = setTimeout(() => {
            tick().catch(() => null);
        }, 4000);
    }

    tick().catch(() => null);

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

function toolLabel(name) {
    const labels = {
        get_token_info: "get token info",
        get_token_narrative: "get token narrative",
        get_token_holders: "get token holders",
        get_top_candidates: "get top candidates",
        get_pool_detail: "get pool detail",
        get_active_bin: "get active bin",
        deploy_position: "deploy position",
        close_position: "close position",
        claim_fees: "claim fees",
        swap_token: "swap token",
        update_config: "update config",
        get_my_positions: "get positions",
        get_wallet_balance: "get wallet balance",
        check_smart_wallets_on_pool: "check smart wallets",
        study_top_lpers: "study top LPers",
        get_top_lpers: "get top LPers",
        search_pools: "search pools",
        discover_pools: "discover pools",
    };
    return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
    if (!result) return "";
    if (result.error) return result.error;
    if (result.reason && result.blocked) return result.reason;
    switch (name) {
        case "deploy_position":
            return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
        case "close_position":
            return result.success ? "closed" : result.reason || "failed";
        case "claim_fees":
            return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
        case "update_config":
            return Object.keys(result.applied || {}).join(", ") || "updated";
        case "get_top_candidates":
            return `${result.candidates?.length ?? 0} candidates`;
        case "get_my_positions":
            return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
        case "get_wallet_balance":
            return `${result.sol ?? "?"} SOL`;
        case "study_top_lpers":
        case "get_top_lpers":
            return `${result.lpers?.length ?? 0} LPers`;
        default:
            return result.success === false ? "failed" : "done";
    }
}

export async function createLiveMessage(title, intro = "Starting...") {
    if (!TOKEN || !chatId) return null;
    const typing = createTypingIndicator();

    const state = {
        title,
        intro,
        toolLines: [],
        footer: "",
        messageId: null,
        flushTimer: null,
        flushPromise: null,
        flushRequested: false,
    };

    function render() {
        const sections = [state.title];
        if (state.intro) sections.push(state.intro);
        if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
        if (state.footer) sections.push(state.footer);
        return sections.join("\n\n").slice(0, 4096);
    }

    async function flushNow() {
        state.flushTimer = null;
        state.flushRequested = false;
        const text = render();
        if (!state.messageId) {
            const sent = await sendMessage(text);
            state.messageId = sent?.result?.message_id ?? null;
            return;
        }
        await editMessage(text, state.messageId);
    }

    function scheduleFlush(delay = 300) {
        if (state.flushTimer) {
            state.flushRequested = true;
            return;
        }
        state.flushTimer = setTimeout(() => {
            state.flushPromise = flushNow().catch(() => null);
        }, delay);
    }

    async function upsertToolLine(name, icon, suffix = "") {
        const label = toolLabel(name);
        const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
        const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
        if (idx >= 0) state.toolLines[idx] = line;
        else state.toolLines.push(line);
        scheduleFlush();
    }

    _liveMessageDepth += 1;
    await flushNow();

    return {
        async toolStart(name) {
            await upsertToolLine(name, "ℹ️", "...");
        },
        async toolFinish(name, result, success) {
            const icon = success ? "✅" : "❌";
            const summary = summarizeToolResult(name, result);
            await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
        },
        async note(text) {
            state.intro = text;
            scheduleFlush();
        },
        async finalize(finalText) {
            if (state.flushTimer) {
                clearTimeout(state.flushTimer);
                state.flushTimer = null;
            }
            if (state.flushPromise) await state.flushPromise;
            // Render final message as HTML for bold/italic/code formatting
            const html = mdToHtml(finalText);
            if (state.messageId) {
                const res = await editMessageHTML(html, state.messageId);
                if (!res?.ok) await editMessage(finalText, state.messageId);
            } else {
                await sendMd(finalText);
            }
            _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
            typing.stop();
        },
        async fail(errorText) {
            if (state.flushTimer) {
                clearTimeout(state.flushTimer);
                state.flushTimer = null;
            }
            if (state.flushPromise) await state.flushPromise;
            state.footer = `❌ ${errorText}`;
            await flushNow();
            _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
            typing.stop();
        },
    };
}

// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
    while (_polling) {
        try {
            const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`, { signal: AbortSignal.timeout(35_000) });
            if (!res.ok) {
                await sleep(5000);
                continue;
            }
            const data = await res.json();
            for (const update of data.result || []) {
                _offset = update.update_id + 1;
                const msg = update.message;
                if (!msg?.text) continue;
                if (!isAuthorizedIncomingMessage(msg)) continue;
                await onMessage(msg);
            }
        } catch (e) {
            if (!e.message?.includes("aborted")) {
                log("telegram_error", `Poll error: ${e.message}`);
            }
            await sleep(5000);
        }
    }
}

export function startPolling(onMessage) {
    if (!TOKEN) return;
    _polling = true;
    poll(onMessage); // fire-and-forget
    log("telegram", "Bot polling started");
}

export function stopPolling() {
    _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
    const priceStr = priceRange
        ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
        : "";
    const coverageStr = rangeCoverage
        ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
        : "";
    const poolStr = binStep || baseFee ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n` : "";
    await sendHTML(
        `✅ <b>Deployed</b> ${pair}\n` +
            `Amount: ${amountSol} SOL\n` +
            priceStr +
            coverageStr +
            poolStr +
            `Position: <code>${position?.slice(0, 8)}...</code>\n` +
            `Tx: <code>${tx?.slice(0, 16)}...</code>`,
    );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, reason }) {
    const sign = pnlUsd >= 0 ? "+" : "";
    const reasonLine = reason ? `\nReason: ${reason}` : "";
    await sendHTML(
        `🔒 <b>Closed</b> ${pair}\n` + `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)${reasonLine}`,
    );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
    await sendHTML(
        `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
            `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
            `Tx: <code>${tx?.slice(0, 16)}...</code>`,
    );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
    await sendHTML(`⚠️ <b>Out of Range</b> ${pair}\n` + `Been OOR for ${minutesOOR} minutes`);
}

export async function notifyDustCleanup(result) {
    if (!result || result.dry_run) return;

    const swapLines = (result.swapped || [])
        .map((s) => `  ${s.symbol || s.mint?.slice(0, 8)}: $${(s.usd_value ?? 0).toFixed(2)} → SOL`)
        .join("\n");
    const failedNote =
        (result.swap_failed || []).length > 0
            ? `\nFailed: ${result.swap_failed.map((s) => s.symbol || s.mint?.slice(0, 8)).join(", ")}`
            : "";

    await sendHTML(
        `🧹 <b>Dust Cleanup</b>\n` +
            `Swapped: ${result.swapped?.length ?? 0} tokens\n` +
            (swapLines ? swapLines + "\n" : "") +
            `Accounts closed: ${result.accounts_closed ?? 0} (${(result.rent_reclaimed_sol ?? 0).toFixed(5)} SOL rent)\n` +
            `SOL gained: ${(result.total_sol_gained ?? 0).toFixed(6)}${failedNote}`,
    );
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
