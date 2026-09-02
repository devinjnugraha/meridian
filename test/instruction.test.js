/**
 * Unit tests for the deterministic position-instruction parser (instruction.js).
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstruction, evaluateInstruction, describeInstruction } from "../instruction.js";

// ── Phrasings that MUST parse to a deterministic condition ──────────────
const PARSE_CASES = [
  ["close at 5% profit", { metric: "pnl_pct", op: ">=", value: 5, action: "close" }],
  ["close at +5%", { metric: "pnl_pct", op: ">=", value: 5, action: "close" }],
  ["close above 4.5% pnl", { metric: "pnl_pct", op: ">=", value: 4.5, action: "close" }],
  ["take profit at 12%", { metric: "pnl_pct", op: ">=", value: 12, action: "close" }],
  ["hold until 5% profit", { metric: "pnl_pct", op: ">=", value: 5, action: "close" }],
  ["close at -10%", { metric: "pnl_pct", op: "<=", value: -10, action: "close" }],
  ["stop at 10% loss", { metric: "pnl_pct", op: "<=", value: -10, action: "close" }],
  ["stop loss at 15%", { metric: "pnl_pct", op: "<=", value: -15, action: "close" }],
  ["close if it drops to -8%", { metric: "pnl_pct", op: "<=", value: -8, action: "close" }],
  ["claim at $5 fees", { metric: "unclaimed_fees_usd", op: ">=", value: 5, action: "claim" }],
  ["claim fees at $2.50", { metric: "unclaimed_fees_usd", op: ">=", value: 2.5, action: "claim" }],
  ["claim when fees reach 10 usd", { metric: "unclaimed_fees_usd", op: ">=", value: 10, action: "claim" }],
  ["close if out of range 60m", { metric: "minutes_out_of_range", op: ">=", value: 60, action: "close" }],
  ["close when out of range for 2 hours", { metric: "minutes_out_of_range", op: ">=", value: 120, action: "close" }],
];

for (const [text, expected] of PARSE_CASES) {
  test(`parses: "${text}"`, () => {
    const parsed = parseInstruction(text);
    assert.ok(parsed, "should parse");
    assert.equal(parsed.metric, expected.metric);
    assert.equal(parsed.op, expected.op);
    assert.equal(parsed.value, expected.value);
    assert.equal(parsed.action, expected.action);
  });
}

// ── Phrasings that MUST be refused (LLM fallback) ───────────────────────
const REFUSE_CASES = [
  "claim fees once pnl hits 10%",           // number not anchored to "fees"
  "claim fees now and close at 5%",          // compound — two intents
  "close at -10% and take profit at 30%",    // compound — two conditions
  "close when the community goes quiet",     // no threshold
  "watch this one closely, meme season soon",
  "stop loss at 15% profit",                 // contradictory
  "hold",
  "",
  null,
  // Stop-shaped notes must never invert into take-profits (down-language w/o
  // an explicit loss marker → refuse, don't guess the sign)
  "close if it drops 10% from peak",
  "close if it falls 10%",
  "close if it goes below entry by 12%",
  // Bare numbers are ambiguous — need an explicit anchor (+, profit word, take-profit verb)
  "close at 5%",
  // Partial-close sizing is a different operation — refuse rather than bind
  // the SIZE as the threshold
  "close 50% at 10% profit",
  "close 100% at 6% gain",
  "exit half if pnl hits 8%",
];

for (const text of REFUSE_CASES) {
  test(`refuses: ${JSON.stringify(text)}`, () => {
    assert.equal(parseInstruction(text), null);
  });
}

// ── Evaluation semantics ────────────────────────────────────────────────
test("evaluateInstruction: pnl at/above target closes", () => {
  const parsed = parseInstruction("close at 5% profit");
  assert.equal(evaluateInstruction(parsed, { pnl_pct: 5 }), true);
  assert.equal(evaluateInstruction(parsed, { pnl_pct: 5.2 }), true);
  assert.equal(evaluateInstruction(parsed, { pnl_pct: 4.9 }), false);
});

test("evaluateInstruction: pnl at/below stop closes", () => {
  const parsed = parseInstruction("stop at 10% loss");
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -10 }), true);
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -12 }), true);
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -9 }), false);
});

test("evaluateInstruction: missing metric holds, never fires", () => {
  const parsed = parseInstruction("close at 5% profit");
  assert.equal(evaluateInstruction(parsed, {}), false);
  assert.equal(evaluateInstruction(parsed, null), false);
  assert.equal(evaluateInstruction(null, { pnl_pct: 99 }), false);
});

test("evaluateInstruction: null pnl is not zero — even a 0% target holds", () => {
  // Number(null) === 0, so a naive check would fire on an unpriceable tick
  const parsed = parseInstruction("close at 0% profit");
  assert.ok(parsed, "0% profit should parse");
  assert.equal(evaluateInstruction(parsed, { pnl_pct: null }), false);
  assert.equal(evaluateInstruction(parsed, { pnl_pct: undefined }), false);
});

test("evaluateInstruction: suspicious PnL ticks never fire the instruction", () => {
  const parsed = parseInstruction("stop at 10% loss");
  // flagged tick (e.g. Jupiter outage) — same guard as getDeterministicCloseRule
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -95, pnl_pct_suspicious: true }), false);
  // absurd -95% print while the position still holds real value
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -95, total_value_usd: 4.2 }), false);
  // a genuine rug: -95% and the value is dust → acts
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -95, total_value_usd: 0.001 }), true);
  // healthy tick below the stop → holds
  assert.equal(evaluateInstruction(parsed, { pnl_pct: -12, total_value_usd: 4.2 }), true);
});

test("evaluateInstruction: fee claim threshold", () => {
  const parsed = parseInstruction("claim at $5 fees");
  assert.equal(evaluateInstruction(parsed, { unclaimed_fees_usd: 5 }), true);
  assert.equal(evaluateInstruction(parsed, { unclaimed_fees_usd: 4.99 }), false);
});

test("describeInstruction renders all metric families", () => {
  assert.match(describeInstruction(parseInstruction("close at 5% profit")), /pnl% >= 5 → close/);
  assert.match(describeInstruction(parseInstruction("claim at $5 fees")), /fees/);
  assert.match(describeInstruction(parseInstruction("close if out of range 60m")), /60m/);
  assert.equal(describeInstruction(null), "unparsed instruction");
});
