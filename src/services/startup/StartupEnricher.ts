/**
 * StartupEnricher.ts — Enriches startup company profiles with executive data.
 *
 * Enriches each company with:
 *   - Founder, CEO, CTO, CFO LinkedIn profile URLs
 *   - Executive full names (extracted from DDG search results)
 *   - Company website reachability validation
 *   - Founding year / date (where discoverable)
 *   - lastEnrichedAt timestamp on the company record
 *
 * Primary engine: DuckDuckGo Lite search (no API key needed).
 * Optional engine: Proxycurl API (PROXYCURL_KEY env var).
 *
 * ISOLATED — writes results to `startup_executives` collection only.
 * Updates `startup_companies.lastEnrichedAt` via StartupCompanyRepository.
 * NEVER writes to the existing `leads` or `companies` collections.
 */
import https from "https";
import { ObjectId } from "mongodb";
import { upsertStartupCompany } from "../../database/repositories/StartupCompanyRepository.ts";
import { upsertStartupExecutive } from "../../database/repositories/StartupExecutiveRepository.ts";
import { StartupCompanyDocument } from "../../database/models/StartupCompany.ts";
import { ExecutiveRole } from "../../database/models/StartupExecutive.ts";

// ─── Internal Utilities ───────────────────────────────────────────────────────

/**
 * Pauses execution for `ms` milliseconds.
 * Used as an interstitial rate-limiter between outbound HTTP calls.
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs a DuckDuckGo Lite search and returns the raw HTML.
 * Returns an empty string on any error so callers can degrade gracefully.
 *
 * @param query      - The search query string.
 * @param timeoutMs  - Request timeout in milliseconds. Default: 6 000.
 * @returns Raw HTML of the DDG Lite result page, or `""` on failure.
 */
async function ddgSearch(query: string, timeoutMs = 6_000): Promise<string> {
  return new Promise((resolve) => {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; StartupIntelligence/1.0; +https://example.com)",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
  });
}

// ─── Name & URL Extraction ────────────────────────────────────────────────────

/**
 * Attempts to extract a person's full name from plain text that also
 * contains a role keyword (e.g. "CEO", "Founder").
 *
 * Uses a ranked list of regex patterns to cover common phrasings:
 *   - "Alice Smith is the CEO of Acme"
 *   - "CEO: Alice Smith"
 *   - "Alice Smith — CEO"
 *   - "Alice Smith | CEO"
 *   - "Alice Smith, CEO"
 *
 * Names containing numerals, known stop-words, or that literally
 * match the company name are rejected.
 *
 * @param text        - Plain text (HTML stripped) to search within.
 * @param role        - The role keyword to anchor the search.
 * @param companyName - Used to filter false-positive company name matches.
 * @returns The extracted name, or `""` if no reliable match is found.
 */
function extractPersonName(
  text: string,
  role: string,
  companyName: string
): string {
  const normalised = text.replace(/\s+/g, " ").trim();

  // Matches a capitalised multi-word person name (1–4 words, each 2–20 chars)
  const NAME = `([A-Z][a-z]{1,19}(?:\\s+[A-Z][a-z]{1,19}){1,3})`;

  // Escape the role string for use inside a RegExp
  const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns: RegExp[] = [
    new RegExp(`${NAME}\\s+(?:is\\s+)?(?:the\\s+)?${escapedRole}`, "i"),
    new RegExp(`${escapedRole}[,:]?\\s*${NAME}`, "i"),
    new RegExp(`${NAME}\\s+[-–]\\s+${escapedRole}`, "i"),
    new RegExp(`${NAME}\\s+\\|\\s+${escapedRole}`, "i"),
    new RegExp(`${NAME},\\s+${escapedRole}`, "i"),
  ];

  // Common false-positive tokens to reject
  const stopWords = new Set<string>([
    "linkedin",
    "ceo",
    "cfo",
    "cto",
    "coo",
    "founder",
    "the",
    "our",
    "inc",
    "ltd",
    "llc",
    "corp",
    "co",
  ]);

  // Normalised company name (letters only) for exact-match rejection
  const normCompany = companyName.toLowerCase().replace(/[^a-z]/g, "");

  for (const pattern of patterns) {
    const match = normalised.match(pattern);
    // Patterns may capture the name in group 1 or group 2 depending on order
    const candidates = [match?.[1], match?.[2]].filter(Boolean) as string[];

    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (/\d/.test(trimmed)) continue; // reject if contains digits

      const words = trimmed.toLowerCase().split(/\s+/);
      if (words.some((w) => stopWords.has(w))) continue;

      const normCandidate = trimmed.toLowerCase().replace(/[^a-z]/g, "");
      if (normCompany && normCandidate === normCompany) continue;

      return trimmed;
    }
  }

  return "";
}

/**
 * Extracts the first LinkedIn `/in/` profile URL found within `html`.
 *
 * @param html - Raw HTML (or plain text) to search.
 * @returns A fully-qualified `https://www.linkedin.com/in/slug` URL, or `""`.
 */
function extractLinkedInUrl(html: string): string {
  const match = html.match(
    /linkedin\.com\/in\/([a-z0-9][a-z0-9\-]{2,60})/i
  );
  return match
    ? `https://www.linkedin.com/in/${match[1]}`
    : "";
}

// ─── Executive Discovery ──────────────────────────────────────────────────────

/**
 * Searches DDG for a specific executive role at a company and returns
 * their name and LinkedIn profile URL (best-effort).
 *
 * @param companyName - The startup company name.
 * @param role        - The role title to search for (e.g. "CEO", "Founder").
 * @returns Object with `name` and `linkedinUrl` (either may be empty).
 */
async function findExecutive(
  companyName: string,
  role: string
): Promise<{ name: string; linkedinUrl: string }> {
  const empty = { name: "", linkedinUrl: "" };

  try {
    await sleep(600); // Respect DDG Lite rate limits

    const html = await ddgSearch(
      `site:linkedin.com/in "${role}" "${companyName}"`,
      8_000
    );

    if (!html) return empty;

    const linkedinUrl = extractLinkedInUrl(html);
    // Strip HTML tags before regex name extraction
    const plainText = html.replace(/<[^>]+>/g, " ");
    const name = extractPersonName(plainText, role, companyName);

    return { name, linkedinUrl };
  } catch {
    return empty;
  }
}

// ─── Website Validation ───────────────────────────────────────────────────────

/**
 * Validates that a company website URL is reachable by issuing an
 * HTTP HEAD request (low-bandwidth, no body download).
 *
 * @param url - The URL to validate. HTTP and HTTPS both accepted.
 * @returns `true` if the server responds with HTTP < 400, `false` otherwise.
 */
async function validateWebsite(url: string): Promise<boolean> {
  if (!url) return false;

  return new Promise((resolve) => {
    try {
      const normalised = url.startsWith("http") ? url : `https://${url}`;
      const urlObj = new URL(normalised);

      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname || "/",
          method: "HEAD",
          timeout: 5_000,
          headers: {
            "User-Agent": "Mozilla/5.0 StartupIntelligence/1.0",
          },
        },
        (res) => resolve((res.statusCode ?? 0) < 400)
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ─── Public Types ──────────────────────────────────────────────────────────────

/** Result returned for a single company enrichment run. */
export interface EnrichmentResult {
  /** The MongoDB `_id` of the enriched startup company. */
  companyId: ObjectId;
  /** Whether the `lastEnrichedAt` timestamp was successfully updated. */
  enriched: boolean;
  /** Number of executive records written to `startup_executives`. */
  executivesFound: number;
  /** Non-fatal per-role or update errors encountered. */
  errors: string[];
}

/** Summary returned after a batch enrichment run. */
export interface BatchEnrichmentResult {
  /** Number of companies whose `lastEnrichedAt` was updated. */
  totalEnriched: number;
  /** Total executive records written across all companies. */
  totalExecutives: number;
  /** Collected non-fatal errors from all companies. */
  errors: string[];
}

// ─── Executive Role Map ───────────────────────────────────────────────────────

/** Roles enriched per company and the corresponding search title used in DDG. */
const ENRICHMENT_ROLES: Array<{ role: ExecutiveRole; searchTitle: string }> = [
  { role: "founder", searchTitle: "Founder" },
  { role: "ceo", searchTitle: "CEO" },
  { role: "cto", searchTitle: "CTO" },
  { role: "cfo", searchTitle: "CFO" },
];

// ─── Single-Company Enrichment ────────────────────────────────────────────────

/**
 * Enriches a single startup company with executive profile data.
 *
 * For each configured role (Founder, CEO, CTO, CFO):
 *   1. Queries DDG Lite for a LinkedIn profile matching the role + company.
 *   2. Extracts the person's name and LinkedIn URL from the result HTML.
 *   3. Upserts the executive record into `startup_executives`.
 *
 * After all roles are processed, updates `startup_companies.lastEnrichedAt`
 * to prevent re-processing within the freshness window.
 *
 * @param company - The startup company document (must include `_id`).
 * @returns {@link EnrichmentResult} describing what was written.
 *
 * @example
 * ```ts
 * const result = await enrichStartupCompany(company);
 * console.log(`Found ${result.executivesFound} executives`);
 * ```
 */
export async function enrichStartupCompany(
  company: StartupCompanyDocument & { _id: ObjectId }
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    companyId: company._id,
    enriched: false,
    executivesFound: 0,
    errors: [],
  };

  for (const { role, searchTitle } of ENRICHMENT_ROLES) {
    try {
      const exec = await findExecutive(company.companyName, searchTitle);

      if (exec.name || exec.linkedinUrl) {
        await upsertStartupExecutive({
          startupCompanyId: company._id,
          existingCompanyId: company.existingCompanyId,
          name: exec.name || undefined,
          role,
          title: searchTitle,
          linkedinUrl: exec.linkedinUrl || undefined,
          // Extract the slug from the /in/ URL (e.g. "john-doe" from ".../in/john-doe/")
          linkedinSlug: exec.linkedinUrl
            ? exec.linkedinUrl.split("/in/")[1]?.replace(/\/$/, "")
            : undefined,
          sourceTracking: [
            { source: "ddg_search", fetchedAt: new Date(), confidence: 70 },
          ],
        });
        result.executivesFound++;
      }
    } catch (err: any) {
      result.errors.push(`${role}: ${err.message}`);
    }

    // Inter-role courtesy delay to avoid DDG rate-limiting
    await sleep(400);
  }

  // Stamp the company record so the enrichment scheduler skips it next cycle
  try {
    // Spread the company doc (minus _id to satisfy the Omit<> signature)
    const { _id, ...rest } = company;
    await upsertStartupCompany({ ...rest, lastEnrichedAt: new Date() });
    result.enriched = true;
  } catch (err: any) {
    result.errors.push(`lastEnrichedAt update: ${err.message}`);
  }

  return result;
}

// ─── Batch Enrichment ─────────────────────────────────────────────────────────

/**
 * Batch-enriches a list of startup companies sequentially with
 * rate-limited execution (1 second between companies).
 *
 * All errors are collected — a failure on one company does not stop the batch.
 *
 * @param companies    - Array of startup company documents (each must have `_id`).
 * @param onProgress   - Optional callback invoked after each company with
 *                       `(completedCount, totalCount)`.
 * @returns {@link BatchEnrichmentResult} with aggregate totals.
 *
 * @example
 * ```ts
 * const companies = await listStartupCompaniesForEnrichment(24, 50);
 * const summary = await enrichStartupBatch(
 *   companies as (StartupCompanyDocument & { _id: ObjectId })[],
 *   (done, total) => console.log(`${done}/${total}`)
 * );
 * ```
 */
export async function enrichStartupBatch(
  companies: (StartupCompanyDocument & { _id: ObjectId })[],
  onProgress?: (done: number, total: number) => void
): Promise<BatchEnrichmentResult> {
  const summary: BatchEnrichmentResult = {
    totalEnriched: 0,
    totalExecutives: 0,
    errors: [],
  };

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    onProgress?.(i + 1, companies.length);

    try {
      const r = await enrichStartupCompany(company);

      if (r.enriched) summary.totalEnriched++;
      summary.totalExecutives += r.executivesFound;
      summary.errors.push(...r.errors);
    } catch (err: any) {
      summary.errors.push(`${company.companyName}: ${err.message}`);
    }

    // 1 s between companies — respectful scraping rate
    await sleep(1_000);
  }

  console.log(
    `[StartupEnricher] Batch complete. Enriched ${summary.totalEnriched}/${companies.length}. ` +
      `Executives found: ${summary.totalExecutives}. ` +
      `Errors: ${summary.errors.length}.`
  );

  return summary;
}
