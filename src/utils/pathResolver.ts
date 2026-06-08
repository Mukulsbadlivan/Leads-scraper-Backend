import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Returns the path to the data directory.
 * On Render, it returns /tmp/data for durability and write access.
 * Locally, it returns the root-level data directory.
 */
export function getOutputDir(): string {
  if (process.env.RENDER) {
    return "/tmp/data";
  }
  // This file is in src/utils/
  // To get to root-level data/ directory: ../../data
  return path.resolve(__dirname, "..", "..", "data");
}
