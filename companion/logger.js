import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function log(type, message) {
  const line = `[${new Date().toISOString()}] [${type}] ${message}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `companion-${dayStamp()}.log`), line + "\n");
  } catch {
    /* logging must never throw */
  }
}
