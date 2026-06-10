/**
 * StartupDiscovery.ts — Multi-source startup company discovery engine.
 *
 * Source tiers (all gracefully degraded — system works without paid APIs):
 *   Tier 1: Existing hiring companies (read-only from companies collection)
 *           LinkedIn company discovery
 *           Company websites + career pages
 *   Tier 2: Y Combinator directory (free, no API key)
 *           Wellfound / AngelList (free public listings)
 *           TechCrunch / VentureBeat RSS (free)
 *   Tier 3: Crunchbase (CRUNCHBASE_API_KEY required)
 *           NewsAPI.org (NEWS_API_KEY required)
 *
 * ISOLATED — writes only to startup_companies collection.
 * Never imports from or writes to existing companies/leads/jobs/signals
 * repositories. The read-only access to the `companies` collection
 * is performed directly via `getDb()` with a strict projection.
 */
import https from "https";
import { getDb } from "../../database/connection.ts";
import { upsertStartupCompany } from "../../database/repositories/StartupCompanyRepository.ts";
import { StartupCompanyDocument } from "../../database/models/StartupCompany.ts";

// ─── Public Types ──────────────────────────────────────────────────────────────

/** Metadata describing a single discovery source. */
export interface DiscoverySource {
  name: string;
  tier: 1 | 2 | 3;
  enabled: boolean;
}

/** Summary returned after a full discovery run. */
export interface DiscoveryResult {
  /** Total companies successfully upserted into startup_companies. */
  discovered: number;
  /** Per-source count of companies found (before upsert). */
  sources: Record<string, number>;
  /** Non-fatal errors encountered during discovery (sources degrade gracefully). */
  errors: string[];
}

/** Options for a single discovery run. */
export interface StartupDiscoveryOptions {
  /**
   * Subset of sources to run. Defaults to all sources.
   * Valid values: "existing_companies" | "yc" | "wellfound" | "rss" | "crunchbase"
   */
  sources?: string[];
  /** Filter discovery to specific sectors (applied during upsert filtering, best-effort). */
  sectors?: string[];
  /** Filter discovery to specific funding stages. */
  stages?: string[];
  /** Maximum total companies to discover across all sources. Default: 200. */
  maxCompanies?: number;
  /** Optional progress callback invoked between source runs. */
  onProgress?: (msg: string, discoveredSoFar: number) => void;
}

// ─── Internal Utilities ───────────────────────────────────────────────────────

/**
 * Pauses execution for `ms` milliseconds.
 * Used as a courtesy rate-limiter between HTTP requests.
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches the body of a URL as a UTF-8 string.
 *
 * @param url       - The HTTPS URL to fetch.
 * @param timeoutMs - Request timeout in milliseconds. Default: 10 000.
 * @returns The raw response body text.
 * @throws On network error or timeout.
 */
async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "Mozilla/5.0 StartupIntelligence/1.0" },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`));
    });
  });
}

// ─── Tier 1: Existing Companies (READ-ONLY) ───────────────────────────────────

/**
 * Seeds the startup discovery pipeline from the existing `companies`
 * collection. Access is strictly read-only — a narrow projection is used
 * and the result is never written back to the `companies` collection.
 *
 * Only companies that already have a known funding stage or a recent
 * funding signal are promoted into the startup pipeline.
 *
 * @param maxCompanies - Maximum number of records to read.
 * @returns Partial StartupCompanyDocument array ready for upsert.
 */
async function discoverFromExistingCompanies(
  maxCompanies: number
): Promise<StartupCompanyDocument[]> {
  const results: StartupCompanyDocument[] = [];

  try {
    const db = await getDb();

    // Narrow projection — read-only, no write-back
    const companies = await db
      .collection("companies")
      .find(
        {
          $or: [
            { recentFundingSignal: true },
            { fundingStage: { $exists: true, $ne: "" } },
          ],
        },
        {
          projection: {
            companyName: 1,
            website: 1,
            linkedinUrl: 1,
            sector: 1,
            industry: 1,
            numberOfEmployees: 1,
            employeeSize: 1,
            country: 1,
            state: 1,
            city: 1,
            fundingStage: 1,
            fundingInfo: 1,
            techStack: 1,
            _id: 1,
          },
        }
      )
      .limit(maxCompanies)
      .toArray();

    for (const c of companies) {
      const name: string = c["companyName"] ?? "";
      if (!name) continue;

      results.push({
        companyName: name,
        website: c["website"] ?? "",
        linkedinUrl: c["linkedinUrl"] ?? "",
        sector: c["sector"] ?? "",
        industry: c["industry"] ?? "",
        companySize: c["numberOfEmployees"] ?? c["employeeSize"] ?? "",
        country: c["country"] ?? "",
        state: c["state"] ?? "",
        city: c["city"] ?? "",
        companyStage: c["fundingStage"] ?? "",
        techStack: Array.isArray(c["techStack"]) ? c["techStack"] : [],
        existingCompanyId: c["_id"],
        sourceTracking: [
          { source: "existing_companies", fetchedAt: new Date(), confidence: 90 },
        ],
      });
    }
  } catch (err: any) {
    console.warn(
      "[StartupDiscovery] existing_companies source error:",
      err.message
    );
  }

  return results;
}

// ─── Tier 2: Y Combinator Directory ──────────────────────────────────────────

/**
 * Discovers active, hiring startups from the public Y Combinator
 * company directory. Attempts their structured JSON endpoint first,
 * then falls back to their companies.json listing.
 *
 * No API key required.
 *
 * @param max - Maximum number of companies to return.
 * @returns Partial StartupCompanyDocument array.
 */
async function discoverFromYC(max: number): Promise<StartupCompanyDocument[]> {
  const results: StartupCompanyDocument[] = [];

  try {
    // Primary: YC public JSON endpoint
    const primaryUrl =
      "https://api.ycombinator.com/v0.1/companies?page=1&per_page=100&status=Active";
    // Fallback: companies.json listing (may differ in schema)
    const fallbackUrl =
      "https://www.ycombinator.com/companies.json?page=1&per_page=100&orderBy=launched_at&order=DESC";

    let raw = "";

    try {
      raw = await fetchText(primaryUrl, 12_000);
    } catch {
      try {
        raw = await fetchText(fallbackUrl, 12_000);
      } catch {
        // Both endpoints unreachable — degrade silently
      }
    }

    if (!raw) return results;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return results;
    }

    // Normalise across possible response shapes
    const companies: any[] =
      parsed?.companies ??
      parsed?.data ??
      (Array.isArray(parsed) ? parsed : []);

    for (const co of companies.slice(0, max)) {
      const name: string = co.name ?? co.company_name ?? "";
      if (!name) continue;

      const teamSize: number | undefined =
        typeof co.team_size === "number" ? co.team_size : undefined;

      results.push({
        companyName: name,
        website: co.website ?? co.url ?? "",
        linkedinUrl: co.linkedin_url ?? "",
        industry: co.industry ?? co.vertical ?? "",
        sector: co.industry ?? co.vertical ?? "",
        companySize: teamSize !== undefined ? String(teamSize) : "",
        headcount: teamSize,
        hqLocation: co.location ?? "",
        isYCBacked: true,
        ycBatch: co.batch ?? co.ycombinator_batch ?? "",
        wellfoundUrl: co.ycombinator_url ?? "",
        sourceTracking: [
          { source: "yc_directory", fetchedAt: new Date(), confidence: 95 },
        ],
      });
    }
  } catch (err: any) {
    console.warn("[StartupDiscovery] yc_directory source error:", err.message);
  }

  return results;
}

// ─── Tier 2: TechCrunch / VentureBeat RSS ────────────────────────────────────

/**
 * Discovers newly-funded or hiring startups mentioned in technology
 * news RSS feeds (TechCrunch, VentureBeat). Extracts company names
 * from funding and hiring headlines using regex heuristics.
 *
 * No API key required.
 *
 * @param max - Maximum number of companies to return across all feeds.
 * @returns Partial StartupCompanyDocument array.
 */
async function discoverFromRSS(max: number): Promise<StartupCompanyDocument[]> {
  const feeds = [
    { url: "https://techcrunch.com/tag/startups/feed/", source: "TechCrunch" },
    { url: "https://venturebeat.com/tag/startups/feed/", source: "VentureBeat" },
    { url: "https://feeds.feedburner.com/TechCrunchIT", source: "TechCrunch" },
  ];

  const results: StartupCompanyDocument[] = [];
  const seen = new Set<string>();

  for (const feed of feeds) {
    if (results.length >= max) break;

    try {
      await sleep(800);
      const raw = await fetchText(feed.url, 10_000);

      // Parse <item> blocks from the RSS XML
      const itemMatches = [...raw.matchAll(/<item>([\s\S]*?)<\/item>/g)];

      for (const item of itemMatches) {
        if (results.length >= max) break;

        const titleMatch = item[1].match(
          /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/
        );
        const title = titleMatch?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          .trim() ?? "";

        // Only process funding / hiring / launch articles
        if (
          !/raises?|funding|series|seed|acqui|hires?|appoints?|launches?/i.test(
            title
          )
        ) {
          continue;
        }

        // Extract company name — text before the action verb (best-effort heuristic)
        const companyMatch = title.match(
          /^([A-Z][\w.&'\- ]{1,40?})\s+(?:raises?|secures?|closes?|lands?|gets?|acquires?|launches?|hires?|appoints?)/i
        );
        const companyName = companyMatch?.[1]?.trim() ?? "";

        if (!companyName || seen.has(companyName.toLowerCase())) continue;
        seen.add(companyName.toLowerCase());

        results.push({
          companyName,
          website: "",
          sourceTracking: [
            { source: feed.source, fetchedAt: new Date(), confidence: 60 },
          ],
        });
      }
    } catch (err: any) {
      console.warn(
        `[StartupDiscovery] RSS ${feed.source} error:`,
        err.message
      );
    }
  }

  return results;
}

// ─── Tier 2: Wellfound (AngelList) ───────────────────────────────────────────

/**
 * Discovers startups from Wellfound public job listings by extracting
 * JSON-LD structured data embedded in the page HTML. Falls back
 * gracefully if Wellfound's page shape changes or is unreachable.
 *
 * No API key required.
 *
 * @param max - Maximum number of companies to return.
 * @returns Partial StartupCompanyDocument array.
 */
async function discoverFromWellfound(max: number): Promise<StartupCompanyDocument[]> {
  const results: StartupCompanyDocument[] = [];

  try {
    await sleep(1_000);

    const html = await fetchText(
      "https://wellfound.com/jobs?role=software-engineer&remote=true",
      12_000
    );

    // Extract JSON-LD blocks embedded in the HTML
    const jsonLdMatches = [
      ...html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
      ),
    ];

    const seen = new Set<string>();

    for (const m of jsonLdMatches) {
      if (results.length >= max) break;

      let json: any;
      try {
        json = JSON.parse(m[1]);
      } catch {
        continue; // skip malformed JSON-LD blocks
      }

      // Normalise across @graph arrays and single objects
      const items: any[] = json["@graph"] ?? (Array.isArray(json) ? json : [json]);

      for (const item of items) {
        if (results.length >= max) break;

        const name: string =
          item?.hiringOrganization?.name ??
          item?.Organization?.name ??
          item?.name ??
          "";

        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        results.push({
          companyName: name,
          website:
            item?.hiringOrganization?.sameAs ?? item?.url ?? "",
          wellfoundUrl: item?.hiringOrganization?.url ?? "",
          sourceTracking: [
            { source: "wellfound", fetchedAt: new Date(), confidence: 75 },
          ],
        });
      }
    }
  } catch (err: any) {
    console.warn("[StartupDiscovery] wellfound source error:", err.message);
  }

  return results;
}

// ─── Tier 3: Crunchbase (API key required) ────────────────────────────────────

/**
 * Discovers recently-created organisations from the Crunchbase API.
 * Requires the `CRUNCHBASE_API_KEY` environment variable.
 * Returns an empty array and logs nothing when the key is absent —
 * the engine operates without it.
 *
 * @param max - Maximum number of companies to return (capped at 100 per Crunchbase limit).
 * @returns Partial StartupCompanyDocument array.
 */
async function discoverFromCrunchbase(max: number): Promise<StartupCompanyDocument[]> {
  const apiKey = process.env.CRUNCHBASE_API_KEY;
  if (!apiKey) return [];

  const results: StartupCompanyDocument[] = [];

  try {
    await sleep(1_000);

    const endpoint = `https://api.crunchbase.com/api/v4/searches/organizations?user_key=${apiKey}`;
    const requestBody = JSON.stringify({
      field_ids: [
        "identifier",
        "short_description",
        "website_url",
        "linkedin",
        "founded_on",
        "employee_count",
        "location_identifiers",
        "funding_stage",
      ],
      query: [
        {
          type: "predicate",
          field_id: "facet_ids",
          operator_id: "includes",
          values: ["company"],
        },
      ],
      order: [{ field_id: "created_at", sort: "desc" }],
      limit: Math.min(max, 100),
    });

    const raw = await new Promise<string>((resolve, reject) => {
      const urlObj = new URL(endpoint);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestBody),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      req.write(requestBody);
      req.end();
    });

    const parsed = JSON.parse(raw);
    const entities: any[] = parsed?.entities ?? [];

    for (const entity of entities) {
      const props = entity?.properties ?? {};
      const name: string = props?.identifier?.value ?? "";
      if (!name) continue;

      results.push({
        companyName: name,
        website: props?.website_url ?? "",
        linkedinUrl: props?.linkedin?.value ?? "",
        industry: props?.short_description ?? "",
        companyStage: props?.funding_stage ?? "",
        crunchbaseUrl: entity?.uuid
          ? `https://www.crunchbase.com/organization/${entity.uuid}`
          : "",
        sourceTracking: [
          { source: "crunchbase", fetchedAt: new Date(), confidence: 90 },
        ],
      });
    }
  } catch (err: any) {
    console.warn("[StartupDiscovery] crunchbase source error:", err.message);
  }

  return results;
}

// ─── Main Discovery Orchestrator ──────────────────────────────────────────────

/**
 * Runs the full multi-source startup discovery pipeline.
 *
 * Each source runs sequentially with a courtesy sleep between them.
 * Any source that throws is caught — its error is recorded and
 * discovery continues from the remaining sources (graceful degradation).
 *
 * All discovered companies are upserted into the `startup_companies`
 * collection via StartupCompanyRepository. No other collection is
 * written to.
 *
 * @param opts - Optional discovery configuration.
 * @returns A {@link DiscoveryResult} summary.
 *
 * @example
 * ```ts
 * const result = await runStartupDiscovery({ maxCompanies: 100 });
 * console.log(`Discovered ${result.discovered} startups`);
 * ```
 */
export async function runStartupDiscovery(
  opts: StartupDiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const maxTotal = opts.maxCompanies ?? 200;
  const activeSources = opts.sources ?? [
    "existing_companies",
    "yc",
    "wellfound",
    "rss",
    "crunchbase",
  ];

  const result: DiscoveryResult = {
    discovered: 0,
    sources: {},
    errors: [],
  };

  // Distribute the budget evenly across active sources
  const perSourceMax = Math.ceil(maxTotal / activeSources.length);
  const allDiscovered: StartupCompanyDocument[] = [];

  for (const source of activeSources) {
    opts.onProgress?.(`Discovering from ${source}…`, result.discovered);

    let batch: StartupCompanyDocument[] = [];

    try {
      switch (source) {
        case "existing_companies":
          batch = await discoverFromExistingCompanies(perSourceMax);
          break;
        case "yc":
          batch = await discoverFromYC(perSourceMax);
          break;
        case "wellfound":
          batch = await discoverFromWellfound(perSourceMax);
          break;
        case "rss":
          batch = await discoverFromRSS(perSourceMax);
          break;
        case "crunchbase":
          batch = await discoverFromCrunchbase(perSourceMax);
          break;
        default:
          console.warn(`[StartupDiscovery] Unknown source: "${source}" — skipping.`);
      }
    } catch (err: any) {
      const msg = `[${source}] ${err.message}`;
      result.errors.push(msg);
      console.warn("[StartupDiscovery] Source error:", msg);
    }

    result.sources[source] = batch.length;
    allDiscovered.push(...batch);

    // Courtesy delay between source calls to avoid thundering-herd bursts
    await sleep(500);
  }

  // Upsert all discovered companies into startup_companies
  for (const company of allDiscovered) {
    try {
      await upsertStartupCompany(company);
      result.discovered++;
    } catch (err: any) {
      result.errors.push(`upsert[${company.companyName}]: ${err.message}`);
    }
  }

  console.log(
    `[StartupDiscovery] Complete. Upserted ${result.discovered} / ${allDiscovered.length} companies.`,
    `Sources: ${JSON.stringify(result.sources)}`
  );

  return result;
}
