/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import fs from "fs";
import { log } from "./logger.js";

const BLACKLIST_FILE = "./token-blacklist.json";

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist (and not expired).
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  const entry = db[mint];
  if (!entry) return false;

  // Check expiry — auto-remove expired entries
  if (entry.expires_at) {
    const expiresAt = new Date(entry.expires_at).getTime();
    if (Date.now() > expiresAt) {
      delete db[mint];
      save(db);
      log("blacklist", `Expired blacklist entry removed: ${entry.symbol || mint}`);
      return false;
    }
  }
  return true;
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason, duration_hours }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    // Update expiry if provided
    if (duration_hours) {
      db[mint].expires_at = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();
      db[mint].duration_hours = duration_hours;
      save(db);
    }
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
      expires_at: db[mint].expires_at || null,
    };
  }

  const entry = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  if (duration_hours) {
    entry.expires_at = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();
    entry.duration_hours = duration_hours;
  }

  db[mint] = entry;

  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}${duration_hours ? ` (${duration_hours}h)` : " permanent"}`);
  return { blacklisted: true, mint, symbol, reason, expires_at: entry.expires_at || null };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}
