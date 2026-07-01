import { getWalletRepo } from "../db.js";

function fmtUsd(n) { return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtSol(n) { return `${Number(n).toFixed(4)} SOL`; }
function signedUsd(delta) { return `${delta >= 0 ? "+" : "-"}${fmtUsd(Math.abs(delta))}`; }
function signedPct(pct) { return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`; }

function deltaLine(label, fromSnap, toSnap) {
  const usdDelta = toSnap.grand_total_usd - fromSnap.grand_total_usd;
  const pct = fromSnap.grand_total_usd > 0 ? (usdDelta / fromSnap.grand_total_usd) * 100 : 0;
  return `• ${label}: ${signedUsd(usdDelta)} (${signedPct(pct)})`;
}

/**
 * Pure renderer. `snapshots` must be ascending by date.
 * Returns Telegram HTML for the wallet-value morning briefing.
 */
export function generateWalletBriefing(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return "📊 <b>Wallet Briefing</b>\n────────────────\nNo snapshot data yet. The auditor will create the first row on its next run.";
  }

  const latest = snapshots[snapshots.length - 1];
  const lines = [
    "📊 <b>Wallet Briefing</b>",
    "────────────────",
    `<b>Today (${latest.date}):</b>`,
    `💰 ${fmtUsd(latest.grand_total_usd)}  ·  ${fmtSol(latest.grand_total_sol)}  (@ $${latest.sol_price.toFixed(2)}/SOL)`,
    `📂 ${latest.position_count} open position(s)`,
  ];

  if (snapshots.length >= 2) {
    const today = new Date(latest.date);
    const pickBefore = (days) => {
      const target = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
      const before = snapshots.filter(s => s.date <= target);
      return before.length ? before[before.length - 1] : null;
    };
    const d7 = pickBefore(7);
    const d30 = pickBefore(30);
    lines.push("", "<b>Change:</b>");
    if (d7) lines.push(deltaLine("7d", d7, latest));
    if (d30) lines.push(deltaLine("30d", d30, latest));
    if (!d7 && !d30) lines.push(`• (not enough history yet — ${snapshots.length} snapshot(s))`);
  }

  lines.push("────────────────");
  return lines.join("\n");
}

/** Convenience: render from the repo's stored history (latest + trailing window). */
export function renderBriefingFromRepo() {
  const repo = getWalletRepo();
  const latest = repo.getLatest();
  if (!latest) return generateWalletBriefing([]);
  // fetch up to ~35 days of history ending at the latest snapshot
  const end = latest.date;
  const start = new Date(new Date(end).getTime() - 35 * 86400000).toISOString().slice(0, 10);
  return generateWalletBriefing(repo.getRange(start, end));
}
