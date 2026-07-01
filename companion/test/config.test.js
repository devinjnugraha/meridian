import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("loadConfig applies schedule + dust defaults", () => {
  const cfg = loadConfig({}, { userConfig: null });
  assert.equal(cfg.schedule.auditCron, "57 1 * * *");
  assert.equal(cfg.schedule.briefingCron, "3 2 * * *");
  assert.equal(cfg.schedule.dustCron, "0 */12 * * *");
  assert.equal(cfg.dust.thresholdUsd, 0.1);
});

test("loadConfig inlines canonical token mints", () => {
  const cfg = loadConfig({}, { userConfig: null });
  assert.equal(cfg.tokens.SOL, "So11111111111111111111111111111111111111112");
  assert.equal(cfg.tokens.USDC, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(cfg.tokens.USDT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
});

test("loadConfig reads gasReserve from user-config.json when present", () => {
  const cfg = loadConfig({}, { userConfig: { management: { gasReserve: 0.5 } } });
  assert.equal(cfg.gasReserve, 0.5);
});

test("loadConfig falls back to default gasReserve when absent", () => {
  const cfg = loadConfig({}, { userConfig: { management: {} } });
  assert.equal(cfg.gasReserve, 0.2);
});

test("loadConfig reads env overrides for cron + threshold", () => {
  const cfg = loadConfig(
    { COMPANION_AUDIT_CRON: "0 5 * * *", COMPANION_DUST_THRESHOLD_USD: "0.25" },
    { userConfig: null },
  );
  assert.equal(cfg.schedule.auditCron, "0 5 * * *");
  assert.equal(cfg.dust.thresholdUsd, 0.25);
});
