/**
 * initStartupDb.ts — Startup Intelligence DB initialization.
 *
 * Creates all indexes for the 7 new isolated startup intelligence collections.
 * Standalone function — does NOT modify or call the existing initDb.ts.
 * Called automatically from startupWorker.ts and companyNewsWorker.ts at startup.
 */
import { ensureStartupCompanyIndexes } from "./repositories/StartupCompanyRepository.ts";
import { ensureStartupExecutiveIndexes } from "./repositories/StartupExecutiveRepository.ts";
import { ensureStartupLeadIndexes } from "./repositories/StartupLeadRepository.ts";
import { ensureCompanyNewsIndexes } from "./repositories/CompanyNewsRepository.ts";
import { ensureFundingEventIndexes } from "./repositories/FundingEventRepository.ts";
import { ensureHiringEventIndexes } from "./repositories/HiringEventRepository.ts";
import { ensureGrowthEventIndexes } from "./repositories/GrowthEventRepository.ts";

export async function initStartupDb(): Promise<void> {
  await Promise.all([
    ensureStartupCompanyIndexes(),
    ensureStartupExecutiveIndexes(),
    ensureStartupLeadIndexes(),
    ensureCompanyNewsIndexes(),
    ensureFundingEventIndexes(),
    ensureHiringEventIndexes(),
    ensureGrowthEventIndexes(),
  ]);
  console.log("📦 Startup Intelligence MongoDB indexes ensured.");
}
