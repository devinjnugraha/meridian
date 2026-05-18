/**
 * One-time migration: seeds lessons.json + state.json closed positions into SQLite.
 *
 * Run: node scripts/seed-lessons-db.js
 *
 * Safe to re-run — uses INSERT OR IGNORE on performance_records (UNIQUE position)
 * and ON CONFLICT upsert on lessons (PRIMARY KEY id).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import MeridianDB from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const LESSONS_FILE = path.join(root, "lessons.json");
const STATE_FILE = path.join(root, "state.json");

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function parseCloseReason(notes) {
  if (!notes?.length) return "unknown";
  const last = notes[notes.length - 1];
  if (last.startsWith("Closed at ")) {
    return last.replace(/^Closed at [^:]+: /, "");
  }
  return last;
}

function parseCloseTime(notes) {
  if (!notes?.length) return null;
  const last = notes[notes.length - 1];
  const m = last.match(/^Closed at (\S+)/);
  return m ? m[1] : null;
}

// ── Run ──────────────────────────────────────────────────────

console.log("Seeding lessons DB from JSON files...\n");

const db = MeridianDB.getInstance();
const lessonsData = loadJSON(LESSONS_FILE);
const stateData = loadJSON(STATE_FILE);

let lessonsSeeded = 0;
let perfSeeded = 0;
let statePositionsSeeded = 0;

// ── 1. Seed performance records from lessons.json ────────────

if (lessonsData?.performance?.length) {
  const perfRun = db._db.transaction((records) => {
    let count = 0;
    for (const rec of records) {
      try {
        db.insertPerformance({
          position: rec.position,
          pool: rec.pool,
          pool_name: rec.pool_name,
          base_mint: rec.base_mint ?? null,
          strategy: rec.strategy ?? null,
          bin_range: rec.bin_range ?? null,
          bin_step: rec.bin_step ?? null,
          volatility: rec.volatility ?? null,
          fee_tvl_ratio: rec.fee_tvl_ratio ?? null,
          organic_score: rec.organic_score ?? null,
          amount_sol: rec.amount_sol ?? null,
          fees_earned_usd: rec.fees_earned_usd ?? null,
          fees_earned_sol: rec.fees_earned_sol ?? null,
          final_value_usd: rec.final_value_usd ?? null,
          initial_value_usd: rec.initial_value_usd ?? null,
          pnl_usd: rec.pnl_usd ?? null,
          pnl_pct: rec.pnl_pct ?? null,
          minutes_in_range: rec.minutes_in_range ?? null,
          minutes_held: rec.minutes_held ?? null,
          range_efficiency: rec.range_efficiency ?? null,
          close_reason: rec.close_reason ?? null,
          signal_snapshot: rec.signal_snapshot ?? null,
          swap_sol_received: rec.swap_sol_received ?? null,
          swap_amount_in: rec.swap_amount_in ?? null,
          swap_tx: rec.swap_tx ?? null,
          deployed_at: rec.deployed_at ?? null,
          recorded_at: rec.recorded_at ?? rec.closed_at ?? new Date().toISOString(),
        });
        count++;
      } catch (e) {
        if (!e.message.includes("UNIQUE constraint")) {
          console.warn(`  Skip perf ${rec.position}: ${e.message}`);
        }
      }
    }
    return count;
  });

  perfSeeded = perfRun(lessonsData.performance);
  console.log(`Performance records: ${perfSeeded} seeded (${lessonsData.performance.length} in JSON)`);
} else {
  console.log("Performance records: none found in lessons.json");
}

// ── 2. Seed lessons from lessons.json ────────────────────────

if (lessonsData?.lessons?.length) {
  const lessonRun = db._db.transaction((lessons) => {
    let count = 0;
    for (const l of lessons) {
      try {
        db.insertLesson({
          id: l.id,
          rule: l.rule,
          tags: l.tags ?? [],
          outcome: l.outcome ?? null,
          sourceType: l.sourceType ?? l.source_type ?? null,
          confidence: l.confidence ?? null,
          context: l.context ?? null,
          pnl_pct: l.pnl_pct ?? null,
          fees_earned_usd: l.fees_earned_usd ?? null,
          initial_value_usd: l.initial_value_usd ?? null,
          range_efficiency: l.range_efficiency ?? null,
          close_reason: l.close_reason ?? null,
          pool: l.pool ?? null,
          pinned: !!l.pinned,
          role: l.role ?? null,
          created_at: l.created_at ?? new Date().toISOString(),
        });
        count++;
      } catch (e) {
        console.warn(`  Skip lesson ${l.id}: ${e.message}`);
      }
    }
    return count;
  });

  lessonsSeeded = lessonRun(lessonsData.lessons);
  console.log(`Lessons: ${lessonsSeeded} seeded (${lessonsData.lessons.length} in JSON)`);
} else {
  console.log("Lessons: none found in lessons.json");
}

// ── 3. Seed closed positions from state.json (not already in DB) ─

if (stateData?.positions) {
  const positions = Object.values(stateData.positions).filter(p => p.closed);
  const existingPositions = new Set(
    db._db.prepare("SELECT position FROM performance_records").all().map(r => r.position),
  );

  const candidates = positions.filter(p => !existingPositions.has(p.position));

  if (candidates.length > 0) {
    const stateRun = db._db.transaction((entries) => {
      let count = 0;
      for (const p of entries) {
        const closedAt = p.closed_at || parseCloseTime(p.notes);
        const deployedAt = p.deployed_at;
        let minutesHeld = null;
        if (deployedAt && closedAt) {
          const ms = new Date(closedAt) - new Date(deployedAt);
          if (Number.isFinite(ms)) minutesHeld = Math.round(ms / 60000);
        }

        try {
          db.insertPerformance({
            position: p.position,
            pool: p.pool,
            pool_name: p.pool_name,
            base_mint: null,
            strategy: p.strategy ?? null,
            bin_range: p.bin_range ?? null,
            bin_step: p.bin_step ?? null,
            volatility: p.volatility ?? null,
            fee_tvl_ratio: p.fee_tvl_ratio ?? null,
            organic_score: p.organic_score ?? null,
            amount_sol: p.amount_sol ?? null,
            fees_earned_usd: p.total_fees_claimed_usd ?? null,
            fees_earned_sol: null,
            final_value_usd: null,
            initial_value_usd: p.initial_value_usd ?? null,
            pnl_usd: null,
            pnl_pct: null,
            minutes_in_range: null,
            minutes_held: minutesHeld,
            range_efficiency: null,
            close_reason: parseCloseReason(p.notes),
            signal_snapshot: p.signal_snapshot ?? null,
            swap_sol_received: null,
            swap_amount_in: null,
            swap_tx: null,
            deployed_at: deployedAt,
            recorded_at: closedAt ?? new Date().toISOString(),
          });
          count++;
        } catch (e) {
          if (!e.message.includes("UNIQUE constraint")) {
            console.warn(`  Skip state ${p.position}: ${e.message}`);
          }
        }
      }
      return count;
    });

    statePositionsSeeded = stateRun(candidates);
    console.log(`State closed positions: ${statePositionsSeeded} seeded (${candidates.length} not already in DB, ${positions.length} total closed)`);
  } else {
    console.log(`State closed positions: all ${positions.length} already in DB`);
  }
} else {
  console.log("State positions: no state.json found or no positions");
}

// ── Summary ──────────────────────────────────────────────────

const totalPerf = db._db.prepare("SELECT COUNT(*) as c FROM performance_records").get().c;
const totalLessons = db._db.prepare("SELECT COUNT(*) as c FROM lessons").get().c;

db.close();

console.log("\n── Summary ──");
console.log(`  performance_records: ${totalPerf} rows`);
console.log(`  lessons:             ${totalLessons} rows`);
console.log("Done.");
