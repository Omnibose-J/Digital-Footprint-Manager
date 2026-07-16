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

export function loadGeminiApiKey() {
  return readConfigExport("GEMINI_API_KEY");
}

/** Empty or placeholder → analytics off. */
export function loadGaMeasurementId() {
  const id = readConfigExport("GA_MEASUREMENT_ID");
  if (!id || id.includes("붙여넣기") || id.includes("여기에")) return "";
  return id;
}
