/**
 * Read local-only exports from src/lib/config.ts (gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, "..", "..", "src", "lib", "config.ts");

function readConfigExport(name) {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const match = text.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`));
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

/**
 * .env is the answer here, config.ts the legacy one.
 *
 * `src/lib/config.ts` resolves ABOVE this repo's root and has never existed in it — it is a Next.js
 * layout that arrived with a merge. Until now that meant the key could not be set at all: the route
 * answered 503 no matter what anyone put in .env, which read as "Gemini is broken" rather than
 * "we are looking in a folder that isn't there".
 *
 * config.ts still wins when present, same as GA below, so nobody's working setup breaks.
 */
export function loadGeminiApiKey() {
  return readConfigExport("GEMINI_API_KEY") || process.env.GEMINI_API_KEY || "";
}

/** Empty or placeholder → analytics off. */
export function loadGaMeasurementId() {
  const id = readConfigExport("GA_MEASUREMENT_ID");
  if (!id || id.includes("붙여넣기") || id.includes("여기에")) return "";
  return id;
}
