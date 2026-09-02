/**
 * Portable repo-wide syntax check — replaces the old
 * `find . -exec node --check {} \;` npm script, which breaks on Windows
 * (npm runs scripts through cmd.exe, where `\;` isn't an escape) and silently
 * under-checks with `-exec {} +` batching (node --check validates one file
 * per invocation, so batched files after the first were skipped).
 *
 * Usage: node scripts/check-syntax.mjs
 */
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { REPO_ROOT } from "../repo-root.js";

const SKIP_DIRS = new Set([".git", "node_modules", "logs", "data", "dist", ".claude", ".worktrees"]);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = collectJsFiles(REPO_ROOT);
let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed++;
    console.error(`FAIL ${relative(REPO_ROOT, file)}\n${res.stderr}`);
  }
}

console.log(`Checked ${files.length} files — ${failed === 0 ? "all OK" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
