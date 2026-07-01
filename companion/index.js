import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";

import { log } from "./logger.js";
import { config } from "./config.js";
import { init, close } from "./db.js";
import { runAudit } from "./features/auditor.js";
import { renderBriefingFromRepo } from "./features/briefing.js";
import { cleanDust } from "./features/dust.js";
import { sendHTML, isEnabled } from "./lib/telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the SHARED ../.env (single source of truth for secrets).
dotenv.config({ path: path.join(__dirname, "..", ".env") });

function validateEnv() {
  const required = ["WALLET_PRIVATE_KEY", "RPC_URL", "HELIUS_API_KEY"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    log("startup_error", `Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!isEnabled()) log("startup_warn", "Telegram not fully configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — messages will be skipped.");
}

async function runJob(name) {
  log("job", `Running ${name}`);
  try {
    if (name === "audit") return await runAudit();
    if (name === "briefing") {
      const html = renderBriefingFromRepo();
      if (isEnabled()) await sendHTML(html);
      else log("briefing", "Telegram disabled — briefing not sent");
      return html;
    }
    if (name === "dust") return await cleanDust();
    throw new Error(`Unknown job: ${name}`);
  } catch (error) {
    log("job_error", `${name} failed: ${error.message}`);
    return null;
  }
}

// ─── Smoke harness: node index.js --run <audit|briefing|dust> ──────────────
const runArg = process.argv.find(a => a.startsWith("--run"));
if (runArg) {
  const job = runArg.split("=")[1] || process.argv[process.argv.indexOf(runArg) + 1];
  validateEnv();
  init();
  log("startup", `Smoke run: ${job} (DRY_RUN=${config.dryRun})`);
  const res = await runJob(job);
  log("startup", `Smoke complete: ${job}`);
  close();
  process.exit(0);
}

// ─── Production: cron schedules ────────────────────────────────────────────
validateEnv();
init();
log("startup", `Companion started (DRY_RUN=${config.dryRun}). audit=${config.schedule.auditCron} briefing=${config.schedule.briefingCron} dust=${config.schedule.dustCron}`);

cron.schedule(config.schedule.auditCron, () => runJob("audit"));
cron.schedule(config.schedule.briefingCron, () => runJob("briefing"));
cron.schedule(config.schedule.dustCron, () => runJob("dust"));

process.on("SIGINT", () => { log("startup", "SIGINT — shutting down"); close(); process.exit(0); });
process.on("SIGTERM", () => { log("startup", "SIGTERM — shutting down"); close(); process.exit(0); });

// Keep the event loop alive (cron schedules are enough, but be explicit).
log("startup", "Companion idling, waiting for scheduled jobs.");
