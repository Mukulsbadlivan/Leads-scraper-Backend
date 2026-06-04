/**
 * initDb.ts — Run this once on startup to ensure all collection indexes exist.
 * Called automatically from Orchastrater.ts before the pipeline begins.
 */
import { ensureCompanyIndexes } from "./repositories/CompanyRepository.js";
import { ensureJobIndexes } from "./repositories/JobRepository.js";
import { ensureLeadIndexes } from "./repositories/LeadRepository.js";
import { ensureSignalIndexes } from "./repositories/SignalRepository.js";
import { ensureScrapeRunIndexes } from "./repositories/ScrapeRunRepository.js";
import { ensureDuplicateAuditIndexes } from "./repositories/DuplicateAuditRepository.js";

export async function initDb(): Promise<void> {
  await Promise.all([
    ensureCompanyIndexes(),
    ensureJobIndexes(),
    ensureLeadIndexes(),
    ensureSignalIndexes(),
    ensureScrapeRunIndexes(),
    ensureDuplicateAuditIndexes(),
  ]);
  console.log("📦 MongoDB indexes ensured.");
}
