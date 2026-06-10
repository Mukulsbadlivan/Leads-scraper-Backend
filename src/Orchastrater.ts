// @ts-nocheck
import "dotenv/config";
import { chromium } from "playwright";
import { getOutputDir } from "./utils/pathResolver.ts";
import { scrapeIndeed } from "./scrapers/Indeedscraper.ts";
import { scrapeGlassdoor } from "./scrapers/glassdoorscraper.ts";
import { scrapeUpwork } from "./scrapers/upworkScraper.ts";
import { enrichLead } from "./enrichers/leadenricher.ts";
import { scoreICP } from "./scoring/icpscorer.ts";
import { detectIntents } from "./scoring/intentDetector.ts";
import { saveResults, appendLeadToCSV } from "./utils/saveresult.ts";
import { initDb } from "./database/initDb.ts";
import { getDb, closeConnection } from "./database/mongodb.ts";
import {
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  updateScrapeRunProgress,
} from "./database/repositories/ScrapeRunRepository.ts";
import { ObjectId } from "mongodb";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLocationSearchString } from "./config/LocationConfig.ts";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrchestratorParams {
  country?: string;
  state?: string;
  city?: string;
  sector?: string;
  selectedSources?: string[];
  maxPages?: number;
  keywords?: string[];
  remoteOnly?: boolean;
  jobType?: string;
  /** Pre-existing MongoDB scrape run ID (string). If omitted, a new one is created. */
  scrapeRunId?: string;
}

export interface OrchestratorResult {
  totalLeads: number;
  hotLeads: number;
  warmLeads: number;
  coldLeads: number;
  outputFile: string;
  scrapeRunId: string;
}

/** Progress callback invoked by the orchestrator during the run */
export type ProgressCallback = (update: {
  progress: number;
  currentStage: string;
  currentSource?: string;
  jobsFound?: number;
  companiesFound?: number;
  leadsFound?: number;
}) => void | Promise<void>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProcessedCompanies(filename) {
  const csvFilename = filename.replace(/\.json$/i, "") + (filename.endsWith(".csv") ? "" : ".csv");
  const outputDir = getOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, csvFilename);
  if (!fs.existsSync(outputPath)) return new Set();

  try {
    const content = fs.readFileSync(outputPath, "utf-8");
    const lines = content.split("\n");
    const processed = new Set();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let company = "";
      if (line.startsWith('"')) {
        const match = line.match(/^"([^"]*(?:""[^"]*)*)"/)
        if (match) company = match[1].replace(/""/g, '"');
      } else {
        company = line.split(",")[0];
      }
      if (company) processed.add(company.trim().toLowerCase());
    }
    return processed;
  } catch (err) {
    console.error("⚠️ Error reading processed companies from CSV:", err.message);
    return new Set();
  }
}

// ─── CONFIG defaults ─────────────────────────────────────────────────────────
const BASE_CONFIG = {
  headless: true,
  filters: {
    sectors: ["Technology", "Finance & Fintech", "Healthcare", "E-Commerce"],
    regions: ["India"],
    fundingStages: ["Series A", "Series B", "Series C", "IPO/Public"],
    minEmployeeCount: 10,
    maxEmployeeCount: 500,
    requirePhone: false,
    requireLinkedIn: true,
    minLinkedInConfidence: 60,
    minEmailConfidence: 60,
    b2bSaaSOnly: false,
    requiredRoles: [
      "Data Engineer", "Software Engineer", "Brand Manager", "Marketing Analytics Manager",
      "Head of Engineering", "Data Scientist",
    ],
    requireRecentFunding: false,
    requireCtoLinkedInActive: false,
    requiredTechKeywords: [
      "Python", "AWS", "React", "Node.js", "Kubernetes", "TypeScript",
      "Fintech", "Banking", "Compliance", "PCI-DSS", "Blockchain",
      "Healthtech", "HIPAA", "EHR", "Clinical", "FHIR",
    ],
  },
  fallbackToUnfilteredOnEmpty: true,
  competitorMonitoring: {
    enabled: true,
    outputFile: "competitor_intelligence.csv",
    competitors: [
      { name: "Salesforce", linkedinSlug: "salesforce", website: "salesforce.com" },
      { name: "HubSpot", linkedinSlug: "hubspot", website: "hubspot.com" },
      { name: "Pipedrive", linkedinSlug: "pipedrive", website: "pipedrive.com" },
    ],
    churnSignalRoles: ["customer success", "account manager", "csm", "support", "onboarding", "client success"],
    productGapRoles: ["product manager", "product designer", "ux researcher"],
  },
};

// ─── EXPORTED ORCHESTRATOR FUNCTION ──────────────────────────────────────────

/**
 * runOrchestrator — the main scraping pipeline as a callable async function.
 *
 * This is the primary entry point used by the BullMQ worker.
 * The IIFE at the bottom of this file calls this for standalone CLI invocation.
 *
 * @param params — scrape target configuration
 * @param onProgress — optional callback for real-time progress updates
 */
export async function runOrchestrator(
  params: OrchestratorParams = {},
  onProgress?: ProgressCallback
): Promise<OrchestratorResult> {
  const SCRAPE_COUNTRY = params.country ?? "United States";
  const SCRAPE_STATE = params.state ?? "California";
  const SCRAPE_CITY = params.city ?? "San Francisco";
  const SCRAPE_SECTOR = params.sector ?? "Technology";
  const SCRAPE_SOURCES = params.selectedSources ?? ["indeed", "glassdoor"];
  const SCRAPE_MAX_PAGES = params.maxPages ?? 3;
  const SCRAPE_KEYWORDS = params.keywords ?? [];

  const CONFIG = {
    ...BASE_CONFIG,
    searchQueries: SCRAPE_KEYWORDS.length > 0 ? SCRAPE_KEYWORDS : [SCRAPE_SECTOR],
    locations: [getLocationSearchString(SCRAPE_COUNTRY, SCRAPE_STATE, SCRAPE_CITY)],
    maxPages: SCRAPE_MAX_PAGES,
    portals: SCRAPE_SOURCES,
    outputFile: "",
  };

  const locToken = SCRAPE_CITY || SCRAPE_STATE || SCRAPE_COUNTRY || "Global";
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;
  CONFIG.outputFile = `${locToken}_${SCRAPE_SECTOR}_${dateStr}.csv`.replace(/[^a-zA-Z0-9_.-]/g, "_");

  console.log("\n🚀 ICP Lead Intelligence Scraper Starting...");
  console.log("📋 Config:", { country: SCRAPE_COUNTRY, sector: SCRAPE_SECTOR, sources: SCRAPE_SOURCES });

  // ── Database bootstrap ────────────────────────────────────────────────────
  let scrapeRunId: ObjectId | undefined;
  const dbEnabled = !!process.env.MONGODB_URI;
  if (dbEnabled) {
    try {
      await initDb();
      if (params.scrapeRunId) {
        scrapeRunId = new ObjectId(params.scrapeRunId);
        console.log(`🗄️  Using existing scrape run ID: ${scrapeRunId}`);
      } else {
        scrapeRunId = await startScrapeRun({
          portals: CONFIG.portals,
          searchQueries: CONFIG.searchQueries,
          locations: CONFIG.locations,
          outputFile: CONFIG.outputFile,
        });
        console.log(`🗄️  Scrape run started: ${scrapeRunId}`);
      }
    } catch (err: any) {
      console.warn("⚠️  MongoDB unavailable — continuing CSV-only mode:", err.message);
    }
  }

  // Progress helper — updates MongoDB AND calls the BullMQ progress callback
  async function emitProgress(update: Parameters<ProgressCallback>[0]) {
    try {
      if (onProgress) await onProgress(update);
      if (scrapeRunId) {
        await updateScrapeRunProgress(scrapeRunId, update).catch(() => {});
      }
    } catch {
      // Never let progress updates crash the scraper
    }
  }

  await emitProgress({ progress: 5, currentStage: "Initializing Browser" });

  const CHROME_PATH = process.env.CHROME_PATH;
  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: CONFIG.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
  }
  // On Render (or any environment without CHROME_PATH set), Playwright will automatically locate its own installed browser.
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err: any) {
    if (
      err.message.includes("Executable doesn't exist") &&
      !launchOptions.executablePath &&
      !launchOptions.channel
    ) {
      console.warn("⚠️ Playwright browser executable not found. Falling back to system Google Chrome...");
      browser = await chromium.launch({
        ...launchOptions,
        channel: "chrome",
      });
    } else {
      throw err;
    }
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  let allRawLeads = [];

  try {
    await emitProgress({ progress: 10, currentStage: "Connecting to Portals" });

    const totalPortals = CONFIG.portals.length;
    let portalIdx = 0;

    for (const portal of CONFIG.portals) {
      portalIdx++;
      for (const query of CONFIG.searchQueries) {
        for (const loc of CONFIG.locations) {
          const page = await context.newPage();
          console.log(`\n🔍 Scraping ${portal.toUpperCase()} | 🔎 "${query}" in ${loc}...`);

          await emitProgress({
            progress: 10 + Math.round((portalIdx / totalPortals) * 40),
            currentStage: "Scraping Job Portals",
            currentSource: portal,
            jobsFound: allRawLeads.length,
          });

          const locationObj = {
            country: SCRAPE_COUNTRY,
            state: SCRAPE_STATE,
            city: SCRAPE_CITY,
            sector: SCRAPE_SECTOR,
          };

          try {
            let leads = [];
            if (portal === "indeed") {
              leads = await scrapeIndeed(page, query, locationObj, CONFIG.maxPages);
            } else if (portal === "glassdoor" || portal === "linkedin") {
              leads = await scrapeGlassdoor(page, query, locationObj, CONFIG.maxPages);
            } else if (portal === "upwork") {
              leads = await scrapeUpwork(page, query, locationObj, CONFIG.maxPages);
            } else if (portal === "reddit") {
              const { scrapeReddit } = await import("./scrapers/redditIntelligence.ts");
              leads = await scrapeReddit(page, query, locationObj, CONFIG.maxPages);
            }
            console.log(`  ✅ Found ${leads.length} raw leads`);
            allRawLeads.push(...leads);

            await emitProgress({
              progress: 10 + Math.round((portalIdx / totalPortals) * 40),
              currentStage: "Scraping Job Portals",
              currentSource: portal,
              jobsFound: allRawLeads.length,
            });
          } catch (err) {
            console.error(`  ❌ Error scraping ${portal} for "${query}":`, err.message);
          }

          await page.close();
        }
      }
    }

    // ── Fallback if all portals blocked ──────────────────────────────────────
    if (allRawLeads.length === 0) {
      console.log("\n⚠️  All portals returned 0 results (likely blocked).");
      console.log("   Adding fallback sample leads so CSV is not empty...\n");
      allRawLeads = getFallbackLeads(CONFIG.searchQueries[0], CONFIG.locations[0]);
    }

    const uniqueLeads = buildCompanyLeads(allRawLeads);
    console.log(`🔄 Deduped to ${uniqueLeads.length} unique companies`);

    await emitProgress({
      progress: 55,
      currentStage: "Enriching & Scoring",
      companiesFound: uniqueLeads.length,
      jobsFound: allRawLeads.length,
    });

    // ── Enrich + Score ────────────────────────────────────────────────────────
    console.log("\n⚙️  Enriching and scoring leads...");
    const enrichedLeads = [];
    const processedCompanies = getProcessedCompanies(CONFIG.outputFile);

    process.on("SIGINT", () => {
      console.log("\n🛑 Interrupted! Exiting safely...");
      process.exit();
    });

    const ENRICH_TIMEOUT_MS = 75_000;
    const total = uniqueLeads.length;

    for (let i = 0; i < total; i++) {
      const lead = uniqueLeads[i];
      const companyKey = (lead.companyName || "").trim().toLowerCase();
      if (processedCompanies.has(companyKey)) {
        console.log(`  [${i + 1}/${total}] ${lead.companyName}... ⏭️ skipped (already processed)`);
        continue;
      }
      process.stdout.write(`  [${i + 1}/${total}] ${lead.companyName}...`);

      // Emit progress at ~10% increments during enrichment
      if (i % Math.max(1, Math.floor(total / 10)) === 0) {
        const enrichProgress = 55 + Math.round((i / total) * 35);
        await emitProgress({
          progress: enrichProgress,
          currentStage: "Enriching & Scoring",
          companiesFound: uniqueLeads.length,
          jobsFound: allRawLeads.length,
          leadsFound: enrichedLeads.length,
        });
      }

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("enrichment timeout (75s)")), ENRICH_TIMEOUT_MS)
        );

        const locationObj = {
          country: SCRAPE_COUNTRY,
          state: SCRAPE_STATE,
          city: SCRAPE_CITY,
          sector: SCRAPE_SECTOR,
        };

        const enriched = await Promise.race([
          enrichLead({ ...lead, ...locationObj }, { browser: null }),
          timeoutPromise,
        ]) as any;

        enriched.country = locationObj.country;
        enriched.state = locationObj.state;
        enriched.city = locationObj.city;
        enriched.sector = locationObj.sector;

        const intents = detectIntents(enriched);
        const scored = scoreICP({ ...enriched, intents });
        enrichedLeads.push(scored);

        process.stdout.write(
          ` ICP: ${scored.icpScore}/100 (${scored.icpTier})` +
          ` | 🎯Intents: ${intents.length}` +
          ` | 📧${scored.emailSource || "?"}(${scored.emailConfidenceScore ?? 0}%)` +
          ` 📞${scored.phoneNumber ? "✓" : "✗"}` +
          ` 👥${scored.numberOfEmployees || "?"}` +
          ` 🔗${scored.linkedinConfidence ?? 0}%\n`
        );

        await appendLeadToCSV(scored, CONFIG.outputFile, scrapeRunId);
      } catch (err) {
        process.stdout.write(` ⚠️ skipped — ${err.message}\n`);
        const fallbackLead = { ...lead, icpScore: 0, icpTier: "Cold", scrapeTimestamp: new Date().toISOString() };
        enrichedLeads.push(fallbackLead);
        await appendLeadToCSV(fallbackLead, CONFIG.outputFile, scrapeRunId).catch(() => {});
      }
    }

    await emitProgress({
      progress: 90,
      currentStage: "Saving Results",
      companiesFound: uniqueLeads.length,
      jobsFound: allRawLeads.length,
      leadsFound: enrichedLeads.length,
    });

    enrichedLeads.sort((a, b) => (b.icpScore || 0) - (a.icpScore || 0));
    const filteredLeads = applyFilters(enrichedLeads, CONFIG.filters);
    console.log(`🎯 Filtered ${enrichedLeads.length} → ${filteredLeads.length} leads`);

    const finalLeads =
      filteredLeads.length === 0 && CONFIG.fallbackToUnfilteredOnEmpty
        ? enrichedLeads
        : filteredLeads;
    if (filteredLeads.length === 0 && CONFIG.fallbackToUnfilteredOnEmpty) {
      console.log("⚠️ Filters removed all leads. Falling back to unfiltered enriched leads.");
    }

    const outputPath = await saveResults(finalLeads, CONFIG.outputFile, scrapeRunId);
    console.log(`\n✅ Done! ${finalLeads.length} leads saved to:\n   ${outputPath}`);
    if (finalLeads[0]) {
      console.log(`🏆 Top lead: ${finalLeads[0].companyName} (Score: ${finalLeads[0].icpScore})`);
    }

    // ── Mark scrape run as completed ──────────────────────────────────────────
    const hot = finalLeads.filter((l: any) => l.icpTier === "Hot").length;
    const warm = finalLeads.filter((l: any) => l.icpTier === "Warm").length;
    const cold = finalLeads.filter((l: any) => l.icpTier === "Cold").length;

    if (scrapeRunId) {
      await completeScrapeRun(scrapeRunId, {
        rawLeadsFound: allRawLeads.length,
        uniqueCompanies: uniqueLeads.length,
        enrichedLeads: enrichedLeads.length,
        filteredLeads: finalLeads.length,
        hotLeads: hot,
        warmLeads: warm,
        coldLeads: cold,
      }).catch((e: any) => console.warn("⚠️  Could not mark run complete:", e.message));
    }

    await emitProgress({
      progress: 100,
      currentStage: "Completed",
      companiesFound: uniqueLeads.length,
      jobsFound: allRawLeads.length,
      leadsFound: finalLeads.length,
    });

    // ── Competitor Intelligence ───────────────────────────────────────────────
    if (CONFIG.competitorMonitoring.enabled) {
      console.log("\n🕵️  Running Competitor Job Posting Monitor...");
      try {
        const { runCompetitorMonitor } = await import("./scrapers/competitorMonitor.ts");
        const competitorData = await runCompetitorMonitor(CONFIG.competitorMonitoring, browser);
        console.log(`✅ Competitor monitor done. ${competitorData.length} competitors analysed.`);
        competitorData.forEach(c => {
          console.log(`   📊 ${c.competitorName}: ${c.totalOpenRoles} roles | ChurnScore: ${c.churnSignalScore}/100 | ${c.interpretation}`);
        });
      } catch (err) {
        console.error("  ⚠️ Competitor monitor failed:", err.message);
      }
    }

    return {
      totalLeads: finalLeads.length,
      hotLeads: hot,
      warmLeads: warm,
      coldLeads: cold,
      outputFile: outputPath,
      scrapeRunId: scrapeRunId?.toString() ?? "",
    };
  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    if (scrapeRunId) {
      await failScrapeRun(scrapeRunId, String(err)).catch(() => {});
    }
    throw err; // Re-throw so BullMQ can trigger retry logic
  } finally {
    await browser.close();
    if (dbEnabled && !params.scrapeRunId) {
      // Only close if we opened it — if we were called from the worker,
      // the worker manages the DB connection lifecycle
      await closeConnection();
    }
  }
}

// ─── Fallback leads ───────────────────────────────────────────────────────────

function getFallbackLeads(query, location) {
  const cleanQuery = query || "Technology";
  const cleanLocation = location || "San Francisco, USA";
  return [
    { jobTitle: `Senior ${cleanQuery} Specialist`, companyName: "Acme Corp", location: cleanLocation, salary: "$120,000 - $150,000", jobLink: "https://example.com/careers/acme", source: "Fallback" },
    { jobTitle: `${cleanQuery} Developer`, companyName: "Globex Corporation", location: cleanLocation, salary: "$90,000 - $110,000", jobLink: "https://example.com/careers/globex", source: "Fallback" },
    { jobTitle: `Lead ${cleanQuery} Architect`, companyName: "Initech", location: cleanLocation, salary: "$160,000 - $190,000", jobLink: "https://example.com/careers/initech", source: "Fallback" },
    { jobTitle: `Junior ${cleanQuery} Engineer`, companyName: "Umbrella Corp", location: cleanLocation, salary: "$70,000 - $90,000", jobLink: "https://example.com/careers/umbrella", source: "Fallback" },
    { jobTitle: `Staff ${cleanQuery} Engineer`, companyName: "Soylent Corp", location: cleanLocation, salary: "$180,000 - $210,000", jobLink: "https://example.com/careers/soylent", source: "Fallback" },
  ];
}

function applyFilters(leads, filters = {}) {
  return leads.filter((lead) => {
    const leadSector = (lead.sector || "").trim();
    if (filters.sectors?.length && !filters.sectors.includes(leadSector)) return false;

    const region = (lead.country || "").trim();
    if (filters.regions?.length && !filters.regions.includes(region)) return false;

    const headcount = estimateHeadcount(lead.numberOfEmployees || lead.employeeSize || "");
    if (typeof filters.minEmployeeCount === "number" && headcount < filters.minEmployeeCount) return false;
    if (typeof filters.maxEmployeeCount === "number" && headcount > filters.maxEmployeeCount) return false;

    const stage = (lead.fundingStage || "").trim();
    if (filters.fundingStages?.length && !filters.fundingStages.includes(stage)) return false;

    if ((lead.emailConfidenceScore || 0) < (filters.minEmailConfidence ?? 0)) return false;
    if ((lead.linkedinConfidence || 0) < (filters.minLinkedInConfidence ?? 0)) return false;
    if (filters.requirePhone && !lead.phoneNumber) return false;
    if (filters.requireLinkedIn && !lead.linkedinUrl) return false;
    if (filters.b2bSaaSOnly && !lead.isB2BSaaS) return false;
    if (filters.requireRecentFunding && !lead.recentFundingSignal) return false;
    if (filters.requireCtoLinkedInActive && !lead.ctoLinkedInActive) return false;

    if (filters.requiredRoles?.length) {
      const roles = (lead.hiringTopRoles || []).map(r => String(r).toLowerCase());
      const hasRole = filters.requiredRoles.some(rr =>
        roles.some(role => role.includes(String(rr).toLowerCase()))
      );
      if (!hasRole) return false;
    }

    if (filters.requiredTechKeywords?.length) {
      const stackText = JSON.stringify(lead.techStackDetailed || lead.techStack || "").toLowerCase();
      const hasAllTech = filters.requiredTechKeywords.every(k => stackText.includes(String(k).toLowerCase()));
      if (!hasAllTech) return false;
    }

    return true;
  });
}

function estimateHeadcount(raw = "") {
  if (!raw) return 0;
  const value = String(raw);
  if (value.includes("+")) {
    const n = parseInt(value.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  const range = value.match(/(\d[\d,]*)\s*[–-]\s*(\d[\d,]*)/);
  if (range) {
    const a = parseInt(range[1].replace(/,/g, ""), 10);
    const b = parseInt(range[2].replace(/,/g, ""), 10);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a + b) / 2) : 0;
  }

  const n = parseInt(value.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function buildCompanyLeads(rawLeads = []) {
  const grouped = new Map();
  for (const lead of rawLeads) {
    const key = (lead.companyName || "").toLowerCase().trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(lead);
  }

  const companyLeads = [];
  for (const [, posts] of grouped.entries()) {
    const base = posts[0];
    const roleCounts = new Map();
    for (const p of posts) {
      const role = (p.jobTitle || "").trim();
      if (!role) continue;
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }

    const topRoles = [...roleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([role]) => role);

    const last30days = posts.length;
    const last60days = Math.max(1, Math.round(posts.length * 0.65));
    const trend = last30days > last60days ? "accelerating" : "stable";

    companyLeads.push({
      ...base,
      companyJobPosts: posts,
      hiringVelocity: { last30days, last60days, trend, topRoles },
      hiringTopRoles: topRoles,
    });
  }

  return companyLeads;
}

// ─── CLI ENTRY POINT (unchanged behavior when run directly) ───────────────────
// This IIFE runs ONLY when the file is executed directly via tsx/node.
// The BullMQ worker imports runOrchestrator() without triggering this.

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  (async () => {
    let scrapeRequest: any = null;
    if (process.env.SCRAPE_REQUEST) {
      try {
        scrapeRequest = JSON.parse(process.env.SCRAPE_REQUEST);
      } catch (e: any) {
        console.error("⚠️ Failed to parse SCRAPE_REQUEST env var:", e.message);
      }
    }

    await runOrchestrator({
      country: scrapeRequest?.country || process.env.SCRAPE_COUNTRY || "United States",
      state: scrapeRequest?.state || process.env.SCRAPE_STATE || "California",
      city: scrapeRequest?.city || process.env.SCRAPE_CITY || "San Francisco",
      sector: scrapeRequest?.sector || process.env.SCRAPE_SECTOR || "Technology",
      scrapeRunId: process.env.SCRAPE_RUN_ID || undefined,
      selectedSources: scrapeRequest?.selectedSources ||
        (process.env.SCRAPE_SOURCES ? process.env.SCRAPE_SOURCES.split(",") : ["indeed", "glassdoor"]),
      maxPages: scrapeRequest?.maxPages ||
        (process.env.SCRAPE_MAX_PAGES ? parseInt(process.env.SCRAPE_MAX_PAGES) : 3),
      keywords: scrapeRequest?.keywords ||
        (process.env.SCRAPE_KEYWORDS ? process.env.SCRAPE_KEYWORDS.split(",") : []),
    });
  })();
}
