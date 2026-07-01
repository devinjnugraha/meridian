import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_USER_CONFIG_PATH = path.join(__dirname, "..", "user-config.json");

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

function readUserConfig(p) {
  try {
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* best-effort; fall through to defaults */
  }
  return {};
}

/**
 * Pure config builder. `env` defaults to process.env at module load.
 * `opts.userConfig` injects a parsed user-config.json (tests);
 * `opts.userConfigPath` overrides the default ../user-config.json path.
 */
export function loadConfig(env = process.env, opts = {}) {
  // opts.userConfig: explicit value used as-is (null = "no user config", hermetic for tests);
  // undefined = fall back to reading ../user-config.json from disk.
  const userConfig = opts.userConfig !== undefined ? opts.userConfig : readUserConfig(opts.userConfigPath ?? DEFAULT_USER_CONFIG_PATH);
  const mgmt = userConfig?.management ?? {};

  const thresholdFromEnv = parseFloat(env.COMPANION_DUST_THRESHOLD_USD);
  const thresholdFromCfg = mgmt.dustThresholdUsd;

  return {
    tokens: TOKENS,
    gasReserve: typeof mgmt.gasReserve === "number" ? mgmt.gasReserve : 0.2,
    dust: {
      thresholdUsd: Number.isFinite(thresholdFromEnv)
        ? thresholdFromEnv
        : Number.isFinite(thresholdFromCfg)
          ? thresholdFromCfg
          : 0.1,
      swapDelayMs: 2000,
      batchSize: 20,
    },
    swap: {
      slippageBps: 300,
      apiKey: "448b0561-15d0-4e51-b632-996c5d7651f7",
    },
    schedule: {
      auditCron: env.COMPANION_AUDIT_CRON || "57 1 * * *",
      briefingCron: env.COMPANION_BRIEFING_CRON || "3 2 * * *",
      dustCron: env.COMPANION_DUST_CRON || "0 */12 * * *",
    },
    dbPath: env.COMPANION_DB_PATH || path.join(__dirname, "data", "companion.db"),
    dryRun: env.DRY_RUN === "true",
  };
}

export const config = loadConfig();
