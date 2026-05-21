import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import MeridianDB from "./db.js";
import { AGENT_ROLE, agentLoop } from "./agent.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function generateBriefing() {
    const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
    const lessonsData = loadJson(LESSONS_FILE) || {
        lessons: [],
        performance: [],
    };

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1. Positions Activity
    const allPositions = Object.values(state.positions || {});
    const openedLast24h = allPositions.filter((p) => new Date(p.deployed_at) > last24h);
    const closedLast24h = allPositions.filter((p) => p.closed && new Date(p.closed_at) > last24h);

    // 2. Performance Activity from performance log
    const perfLast24h = (lessonsData.performance || []).filter((p) => new Date(p.recorded_at) > last24h);
    const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
    const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

    // 3. Lessons Learned
    const lessonsLast24h = (lessonsData.lessons || []).filter((l) => new Date(l.created_at) > last24h);
    const lessonsSummary = await summarizeLessonsForBriefing(lessonsLast24h);

    // 4. Current State
    const openPositions = allPositions.filter((p) => !p.closed);
    const perfSummary = getPerformanceSummary();

    // 5. Wallet Performance from performance auditor / SQLite
    const walletSection = buildWalletSection();

    // 6. Format Message
    const lines = [
        "☀️ <b>Morning Briefing</b> (Last 24h)",
        "────────────────",

        "<b>Activity:</b>",
        `📥 Positions Opened: ${openedLast24h.length}`,
        `📤 Positions Closed: ${closedLast24h.length}`,
        "",

        "<b>Position Performance:</b>",
        `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
        `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
        perfLast24h.length > 0
            ? `📈 Win Rate (24h): ${Math.round(
                  (perfLast24h.filter((p) => p.pnl_usd > 0).length / perfLast24h.length) * 100,
              )}%`
            : "📈 Win Rate (24h): N/A",
        "",

        walletSection,

        "<b>Lessons Learned:</b>",
        lessonsSummary,
        "",

        "<b>Current Portfolio:</b>",
        `📂 Open Positions: ${openPositions.length}`,
        perfSummary
            ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
            : "",

        "────────────────",
    ];

    return sanitizeTelegramHtml(lines.join("\n"));
}

function buildWalletSection() {
    let db;

    try {
        db = MeridianDB.getInstance();
    } catch {
        return "<b>Wallet Performance:</b>\n• Database unavailable\n";
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const todaySnap = db.getSnapshot(today);
    const yesterdaySnap = db.getSnapshot(yesterday);
    const weekSnaps = db.getSnapshotsRange(weekAgo, today) || [];

    if (!todaySnap) {
        return "<b>Wallet Performance:</b>\n• No snapshot recorded yet — auditor will capture today's data.\n";
    }

    const pctChange = (current, previous) => {
        if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
            return 0;
        }

        return ((current - previous) / previous) * 100;
    };

    const formatSignedUsd = (value) => {
        const safeValue = Number.isFinite(value) ? value : 0;
        return `${safeValue >= 0 ? "+" : ""}$${safeValue.toFixed(2)}`;
    };

    const formatSignedSol = (value) => {
        const safeValue = Number.isFinite(value) ? value : 0;
        return `${safeValue >= 0 ? "+" : ""}${safeValue.toFixed(4)} SOL`;
    };

    const formatSignedPct = (value) => {
        const safeValue = Number.isFinite(value) ? value : 0;
        return `${safeValue >= 0 ? "+" : ""}${safeValue.toFixed(1)}%`;
    };

    const lines = ["<b>Wallet Performance:</b>"];

    lines.push(
        `💵 Total: $${todaySnap.grand_total_usd.toFixed(2)} / ${todaySnap.grand_total_sol.toFixed(4)} SOL @ $${todaySnap.sol_price.toFixed(2)}`,
    );

    lines.push(
        `   Wallet: $${todaySnap.wallet_usd.toFixed(2)} | LP Positions (${todaySnap.position_count}): $${todaySnap.positions_usd.toFixed(2)} (${todaySnap.positions_sol.toFixed(4)} SOL)`,
    );

    if (yesterdaySnap) {
        const diff24Usd = todaySnap.grand_total_usd - yesterdaySnap.grand_total_usd;
        const pct24Usd = pctChange(todaySnap.grand_total_usd, yesterdaySnap.grand_total_usd);

        const diff24Sol = todaySnap.grand_total_sol - yesterdaySnap.grand_total_sol;
        const pct24Sol = pctChange(todaySnap.grand_total_sol, yesterdaySnap.grand_total_sol);

        lines.push(
            `📅 Yesterday: $${yesterdaySnap.grand_total_usd.toFixed(2)} / ${yesterdaySnap.grand_total_sol.toFixed(4)} SOL`,
        );

        lines.push("📊 24h Change:");
        lines.push(`   USD: ${formatSignedUsd(diff24Usd)} (${formatSignedPct(pct24Usd)})`);
        lines.push(`   SOL: ${formatSignedSol(diff24Sol)} (${formatSignedPct(pct24Sol)})`);
    }

    const sortedWeekSnaps = weekSnaps
        .filter((snap) => snap && snap.date && snap.date !== today)
        .sort((a, b) => a.date.localeCompare(b.date));

    if (sortedWeekSnaps.length >= 1) {
        const oldest = sortedWeekSnaps[0];

        const diff7dUsd = todaySnap.grand_total_usd - oldest.grand_total_usd;
        const pct7dUsd = pctChange(todaySnap.grand_total_usd, oldest.grand_total_usd);

        const diff7dSol = todaySnap.grand_total_sol - oldest.grand_total_sol;
        const pct7dSol = pctChange(todaySnap.grand_total_sol, oldest.grand_total_sol);

        lines.push(`📆 7d Change from ${oldest.date}:`);
        lines.push(`   USD: ${formatSignedUsd(diff7dUsd)} (${formatSignedPct(pct7dUsd)})`);
        lines.push(`   SOL: ${formatSignedSol(diff7dSol)} (${formatSignedPct(pct7dSol)})`);
    } else if (!yesterdaySnap) {
        lines.push("• First snapshot recorded — comparisons available tomorrow.");
    }

    lines.push("");

    return lines.join("\n");
}

async function summarizeLessonsForBriefing(lessonsLast24h, { maxLessons = 20, maxBullets = 5 } = {}) {
    if (!lessonsLast24h || lessonsLast24h.length === 0) {
        return "• No new lessons recorded overnight.";
    }

    const fallback = lessonsLast24h
        .slice(0, maxBullets)
        .map((l) => `• ${esc(l.rule || l.lesson || JSON.stringify(l))}`)
        .join("\n");

    try {
        const lessonItems = lessonsLast24h.slice(0, maxLessons).map((l, index) => ({
            index: index + 1,
            rule: l.rule || "",
            reason: l.reason || "",
            context: l.context || "",
            outcome: l.outcome || "",
            created_at: l.created_at || "",
        }));

        const goal = [
            "Summarize the following trading bot lessons for a Telegram morning briefing.",
            "",
            "Rules:",
            `- Return at most ${maxBullets} bullets.`,
            "- Each bullet must start with •",
            "- Keep bullets short, practical, and readable.",
            "- Use only the provided lessons.",
            "- Do not invent facts.",
            "- Do not include HTML tags.",
            "- Do not include a heading.",
            "- Do not give financial advice.",
            "",
            "Lessons JSON:",
            JSON.stringify(lessonItems, null, 2),
        ].join("\n");

        const result = await agentLoop(goal, 1, [], AGENT_ROLE.GENERAL, 350, {
            allowTools: false,
        });

        const content = result?.content?.trim();

        if (!content) {
            return fallback;
        }

        const bullets = content
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                if (line.startsWith("•")) return line;
                if (line.startsWith("-")) return `• ${line.slice(1).trim()}`;
                return `• ${line}`;
            })
            .slice(0, maxBullets);

        return bullets.length > 0 ? bullets.map((line) => esc(line)).join("\n") : fallback;
    } catch (err) {
        log("briefing_error", `Failed to summarize lessons with agentLoop: ${err.message}`);
        return fallback;
    }
}

function loadJson(file) {
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        log("briefing_error", `Failed to read ${file}: ${err.message}`);
        return null;
    }
}

// Preserve intentional HTML tags Telegram supports; escape everything else.
const ALLOWED_TAGS = /<\/?(?:b|i|code|pre|s|u|em|strong|a|tg-spoiler|blockquote|del)>/g;
function sanitizeTelegramHtml(html) {
    const saved = [];
    let safe = html.replace(ALLOWED_TAGS, (m) => {
        saved.push(m);
        return `\x00${saved.length - 1}\x00`;
    });
    safe = safe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return safe.replace(/\x00(\d+)\x00/g, (_, i) => saved[+i]);
}
