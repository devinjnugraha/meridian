/**
 * Deterministic position-instruction parser.
 *
 * Operator instructions ("set <n> close at 5% profit") are almost always simple
 * threshold conditions. When the text parses to exactly one, the management
 * cycle evaluates it in JS and skips the LLM instruction-eval round-trip
 * entirely. Anything ambiguous — multiple conditions, no recognizable shape —
 * falls back to the MANAGER LLM unchanged. The parser is deliberately
 * conservative: tight gaps, whitelisted metrics, refuse-on-ambiguity.
 *
 * Note: instructions pass through sanitizeStoredText (no newlines, no <>),
 * so patterns must not depend on angle brackets.
 */

// Whitelisted position metrics an instruction may test.
const METRICS = new Set(["pnl_pct", "unclaimed_fees_usd", "minutes_out_of_range"]);

const NUM = String.raw`(\d+(?:\.\d+)?)`;

function pnlAt(op, value, action, text) {
  return { metric: "pnl_pct", op, value, action, text };
}

/**
 * Ordered patterns, most specific first. parseInstruction collects ALL matches
 * and only accepts when exactly one distinct condition emerges — a compound
 * instruction ("claim fees now and close at 5%") is LLM work, not a guess.
 */
const PATTERNS = [
  // ── Loss side (explicit negatives) ──
  // "close at -10%", "stop at -8% pnl", "close if it drops to -12%"
  {
    re: new RegExp(String.raw`\b(?:close|sell|exit|stop(?:\s*loss)?|cut)\b[^.;]{0,40}?(?:at|below|under|of|to)\s*-${NUM}\s*%`, "i"),
    build: (m, text) => pnlAt("<=", -Number(m[1]), "close", text),
  },
  // "stop at 10% loss", "close at 8% loss", "cut at 15 percent drawdown"
  {
    re: new RegExp(String.raw`\b(?:close|sell|exit|stop|cut)\b[^.;]{0,40}?${NUM}\s*(?:%|percent)\s*(?:loss|drawdown|down)\b`, "i"),
    build: (m, text) => pnlAt("<=", -Number(m[1]), "close", text),
  },
  // "stop loss at 15%" — the loss word precedes the number
  {
    re: new RegExp(String.raw`\bstop\s*loss\b[^.;]{0,20}?${NUM}\s*(?:%|percent)(?!\s*(?:profit|gain))`, "i"),
    build: (m, text) => pnlAt("<=", -Number(m[1]), "close", text),
  },

  // ── Fee claims — the word "fees" must anchor the number ──
  // "claim at $5 fees", "claim 5 usd in unclaimed fees"
  {
    re: new RegExp(String.raw`\bclaim\b[^.;]{0,20}?\$?\s*${NUM}\s*(?:usd|dollars?|\$)?\s*(?:in\s+)?(?:unclaimed\s+)?fees?\b`, "i"),
    build: (m, text) => ({ metric: "unclaimed_fees_usd", op: ">=", value: Number(m[1]), action: "claim", text }),
  },
  // "claim fees at $2.50", "claim fees reach 10 usd" (tight gaps — compound
  // sentences like "claim fees once pnl hits 10%" must NOT match here)
  {
    re: new RegExp(String.raw`\bclaim\b[^.;]{0,8}?\bfees?\b[^.;]{0,12}?(?:at|above|over|reach(?:es)?|=|of)?\s*\$?\s*${NUM}\s*(?:usd|dollars?|\$)?\b`, "i"),
    build: (m, text) => ({ metric: "unclaimed_fees_usd", op: ">=", value: Number(m[1]), action: "claim", text }),
  },

  // ── Out-of-range duration ──
  // "close if out of range 60m", "close when out of range for 2 hours"
  {
    re: new RegExp(String.raw`\b(?:close|sell|exit)\b[^.;]{0,60}?\bout\s+of\s+range\b[^.;]{0,30}?\b${NUM}\s*(m|min|mins|minutes|h|hr|hrs|hours?)\b`, "i"),
    build: (m, text) => ({
      metric: "minutes_out_of_range",
      op: ">=",
      value: /^h/.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]),
      action: "close",
      text,
    }),
  },

  // ── Profit side (last — STRICTLY anchored) ──
  // A bare number after "close" is ambiguous ("close at 5%" vs "close 5%"), and a
  // misread turns a stop into a take-profit. Only three anchors are accepted:
  // an explicit "+" sign, an explicit qualifier word after the %, or the
  // "take profit" verb. Everything else falls to the LLM.
  // "close at +5%", "close at +5% profit"
  {
    re: new RegExp(String.raw`\b(?:close|sell|exit|take\s+profit|hold\s+(?:until|till))\b[^.;]{0,40}?(?:at|above|over|reach(?:es)?|of)?\s*\+${NUM}\s*%`, "i"),
    build: (m, text) => pnlAt(">=", Number(m[1]), "close", text),
  },
  // "close at 5% profit", "close above 4.5% pnl", "hold until 5% gain"
  {
    re: new RegExp(String.raw`\b(?:close|sell|exit|take\s+profit|hold\s+(?:until|till))\b[^.;]{0,40}?(?:at|above|over|reach(?:es)?|of)?\s*\+?(?<![-\d])${NUM}\s*%\s*(?:profit|pnl|gain|up)\b`, "i"),
    build: (m, text) => pnlAt(">=", Number(m[1]), "close", text),
  },
  // "take profit at 12%" — the verb itself carries the profit meaning
  {
    re: new RegExp(String.raw`\btake\s+profit\b[^.;]{0,30}?(?:at|of|above|over)?\s*\+?(?<![-\d])${NUM}\s*%`, "i"),
    build: (m, text) => pnlAt(">=", Number(m[1]), "close", text),
  },
];

// Down-language without an explicit loss marker ("-N", "N% loss", "drawdown") is
// ambiguous — "close if it drops 10%" is a STOP, and misparsing it as a
// take-profit removes stop protection entirely. Refuse to the LLM.
const DOWN_LANGUAGE = /\b(drops?|dropped|falls?|fell|dips?|dipped|goes?\s+below|below\s+entry|underwater|crashes?|bleeds?)\b/i;
const EXPLICIT_LOSS = /-\d|(?:%|percent)?\s*(?:loss|drawdown)\b/i;

// Partial-close sizing ("close 50% at 10% profit", "exit half at 8%") is a
// different operation than this parser supports — the first-number capture
// would bind the SIZE as the threshold. Refuse to the LLM.
const SIZE_LANGUAGE = /\b(?:half|halve|partial(?:ly)?|trim|quarter)\b|\b(?:close|sell|exit)\s+\d+(?:\.\d+)?\s*%/i;

/**
 * Parse a position instruction into a deterministic condition.
 * @returns {{metric, op, value, action, text}} | null when unparseable/ambiguous
 */
export function parseInstruction(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim().slice(0, 280);

  if (SIZE_LANGUAGE.test(trimmed)) return null;
  if (DOWN_LANGUAGE.test(trimmed) && !EXPLICIT_LOSS.test(trimmed)) return null;

  const found = new Map(); // keyed by condition identity — dedupes overlapping patterns
  for (const { re, build } of PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const parsed = build(m, trimmed);
    if (!METRICS.has(parsed.metric)) return null;
    if (!Number.isFinite(parsed.value)) continue;
    if (!["close", "claim"].includes(parsed.action)) return null;
    found.set(`${parsed.metric}|${parsed.op}|${parsed.value}|${parsed.action}`, parsed);
  }

  if (found.size !== 1) return null; // zero matches, or ambiguous compound — LLM decides
  const parsed = [...found.values()][0];

  // Verb consistency: if the text mentions an action verb the parsed condition
  // doesn't cover, there's a second intent we can't see ("claim fees now and
  // close at 5%") — the LLM evaluates it instead.
  const mentionsClaim = /\bclaim\b/i.test(trimmed);
  const mentionsClose = /\b(?:close|exit|sell)\b/i.test(trimmed);
  if (mentionsClaim && parsed.action !== "claim") return null;
  if (mentionsClose && parsed.action !== "close") return null;

  return parsed;
}

/**
 * Evaluate a parsed instruction against a live position snapshot.
 * Missing metrics evaluate to false (hold — never act on bad data), and PnL
 * conditions respect the same bad-tick heuristics as the deterministic close
 * rules: a flagged tick or an absurd -90% print on a position that still holds
 * value is garbage, not a signal.
 */
export function evaluateInstruction(parsed, position) {
  if (!parsed || !position) return false;
  const raw = position[parsed.metric];
  if (raw === null || raw === undefined || raw === "") return false;
  const live = Number(raw);
  if (!Number.isFinite(live)) return false;
  if (parsed.metric === "pnl_pct" && isSuspiciousPnl(position)) return false;
  switch (parsed.op) {
    case ">=": return live >= parsed.value;
    case "<=": return live <= parsed.value;
    case ">":  return live > parsed.value;
    case "<":  return live < parsed.value;
    default:   return false;
  }
}

// Mirrors the pnlSuspect block in index.js#getDeterministicCloseRule.
function isSuspiciousPnl(position) {
  if (position.pnl_pct_suspicious) return true;
  const pnl = Number(position.pnl_pct);
  const value = Number(position.total_value_usd);
  return Number.isFinite(pnl) && pnl <= -90 && Number.isFinite(value) && value > 0.01;
}

/** Human-readable form for logs, reports, and decision entries. */
export function describeInstruction(parsed) {
  if (!parsed) return "unparsed instruction";
  if (parsed.metric === "pnl_pct")        return `pnl% ${parsed.op} ${parsed.value} → ${parsed.action}`;
  if (parsed.metric === "unclaimed_fees_usd") return `fees $${parsed.op === "<=" ? "≤" : "≥"} ${parsed.value} → ${parsed.action}`;
  return `oor ${parsed.op} ${parsed.value}m → ${parsed.action}`;
}
