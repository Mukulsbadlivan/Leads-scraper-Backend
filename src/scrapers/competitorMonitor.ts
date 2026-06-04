// @ts-nocheck
// ─── Competitor Job Posting Monitor ─────────────────────────────────────────
// Scrapes competitor companies' job listings to detect:
//   - Heavy CS/Sales hiring  → their customers are likely underserved
//   - Engineering-only hiring → product building phase
// Outputs a separate competitor_intelligence.csv
//
// Source waterfall per competitor:
//   Tier 1 → LinkedIn company jobs page (Playwright)
//   Tier 2 → Indeed RSS feed (via scrapeIndeed from Indeedscraper.ts)
//   Tier 3 → Company careers/jobs page (ddgGet)

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ddgGet, jitter } from "./linkedinScraper.ts";
import { scrapeIndeed }   from "./Indeedscraper.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompetitorConfig {
    enabled: boolean;
    competitors: Array<{ name: string; linkedinSlug: string; website: string }>;
    outputFile: string;
    churnSignalRoles: string[];
    productGapRoles:  string[];
}

export interface CompetitorIntelligence {
    competitorName:         string;
    linkedinSlug:           string;
    totalOpenRoles:         number;
    csHiringCount:          number;
    engineeringHiringCount: number;
    productHiringCount:     number;
    salesHiringCount:       number;
    churnSignalScore:       number;
    topRolesHiring:         string[];
    hiringTrend:            "accelerating" | "stable" | "declining";
    scrapeSource:           string;
    scrapedAt:              string;
    rawJobTitles:           string[];
    interpretation:         string;
}

// ─── Role categoriser ─────────────────────────────────────────────────────────

export function categoriseRole(title) {
    const t = title.toLowerCase();
    if (/customer success|account manager|csm|client success|support engineer|onboarding/.test(t)) return "cs";
    if (/engineer|developer|architect|devops|sre|platform|backend|frontend|fullstack|software/.test(t)) return "engineering";
    if (/product manager|product designer|ux|ui designer|researcher/.test(t)) return "product";
    if (/sales|account executive|business development|revenue|growth/.test(t)) return "sales";
    if (/marketing|brand|content|seo|demand gen/.test(t)) return "marketing";
    return "other";
}

// ─── Authwall detector ────────────────────────────────────────────────────────

function isAuthwall(url) {
    return /login|authwall|signup|checkpoint/i.test(url);
}

// ─── Tier 1: LinkedIn jobs page (Playwright) ──────────────────────────────────

async function scrapeLinkedInJobs(linkedinSlug, browser) {
    if (!browser) return [];
    let page = null;
    try {
        page = await browser.newPage();
        await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", r => r.abort());

        const url = `https://www.linkedin.com/company/${linkedinSlug}/jobs/`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(2500 + Math.random() * 1000);

        if (isAuthwall(page.url())) return [];

        const titles = await page.evaluate(() => {
            const els = document.querySelectorAll(
                ".job-card-list__title, .jobs-unified-top-card__job-title, " +
                "h3.base-search-card__title, a.job-card-container__link"
            );
            return Array.from(els)
                .map(el => el.innerText?.trim())
                .filter(t => t && t.length > 2);
        });

        return titles;
    } catch (err) {
        console.warn(`[competitorMonitor] LinkedIn jobs scrape (${linkedinSlug}):`, err.message);
        return [];
    } finally {
        if (page) try { await page.close(); } catch {}
    }
}

// ─── Tier 2: Indeed RSS fallback ─────────────────────────────────────────────

async function scrapeIndeedFallback(competitorName, browser) {
    if (!browser) return [];
    let page = null;
    try {
        page = await browser.newPage();
        const leads = await scrapeIndeed(page, competitorName, "", 1);
        return leads.map(l => l.jobTitle).filter(Boolean);
    } catch (err) {
        console.warn(`[competitorMonitor] Indeed fallback (${competitorName}):`, err.message);
        return [];
    } finally {
        if (page) try { await page.close(); } catch {}
    }
}

// ─── Tier 3: Company careers/jobs page (ddgGet) ───────────────────────────────

async function scrapeCompanySite(website) {
    if (!website) return [];
    const paths = ["/careers", "/jobs", "/careers/", "/jobs/"];
    const titles = [];

    for (const p of paths) {
        try {
            await jitter(600, 1400);
            const url  = `https://${website.replace(/^https?:\/\//, "")}${p}`;
            const html = await ddgGet(url, 12000);
            if (!html || html.length < 100) continue;

            // Extract text from h2/h3/li near job keywords
            const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                                  .replace(/<style[\s\S]*?<\/style>/gi, "");

            const tagMatches = [
                ...stripped.matchAll(/<(?:h2|h3|li|a)[^>]*>([^<]{5,120})<\/(?:h2|h3|li|a)>/gi),
            ];
            for (const m of tagMatches) {
                const text = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
                if (/engineer|manager|success|sales|designer|analyst|developer|director/i.test(text)) {
                    titles.push(text.slice(0, 100));
                }
            }
            if (titles.length > 0) break;
        } catch { /* try next path */ }
    }

    return titles;
}

// ─── Score + interpretation ───────────────────────────────────────────────────

function buildIntelligence(competitor, rawTitles, scrapeSource) {
    const counts = { cs: 0, engineering: 0, product: 0, sales: 0, marketing: 0, other: 0 };
    const roleTally = new Map();

    for (const title of rawTitles) {
        const cat = categoriseRole(title);
        counts[cat] = (counts[cat] || 0) + 1;
        roleTally.set(title, (roleTally.get(title) || 0) + 1);
    }

    const total = rawTitles.length;
    const csRatio       = total > 0 ? counts.cs / total : 0;
    const churnSignalScore = Math.round(csRatio * 100);

    // hiringTrend
    const goToMarket    = counts.cs + counts.sales;
    const engineering   = counts.engineering;
    let hiringTrend     = "stable";
    if (goToMarket > engineering * 1.5) hiringTrend = "accelerating";
    else if (engineering > goToMarket * 2) hiringTrend = "stable";

    // Interpretation
    let interpretation;
    if (churnSignalScore >= 40) {
        interpretation = "Heavy CS hiring → competitor customers likely underserved. Target their accounts.";
    } else if (churnSignalScore >= 20) {
        interpretation = "Moderate CS hiring → some customer pain possible. Worth monitoring.";
    } else if (engineering > total * 0.5) {
        interpretation = "Engineering-heavy → product building phase, less churn risk.";
    } else {
        interpretation = "Low CS hiring → competitor appears stable.";
    }

    // Top 5 roles by frequency
    const topRolesHiring = [...roleTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([role]) => role);

    return {
        competitorName:         competitor.name,
        linkedinSlug:           competitor.linkedinSlug,
        totalOpenRoles:         total,
        csHiringCount:          counts.cs,
        engineeringHiringCount: counts.engineering,
        productHiringCount:     counts.product,
        salesHiringCount:       counts.sales,
        churnSignalScore,
        topRolesHiring,
        hiringTrend,
        scrapeSource,
        scrapedAt:       new Date().toISOString(),
        rawJobTitles:    rawTitles,
        interpretation,
    };
}

// ─── CSV serialisation ────────────────────────────────────────────────────────

const COMPETITOR_COLUMNS = [
    "competitorName", "linkedinSlug", "totalOpenRoles",
    "csHiringCount", "engineeringHiringCount", "productHiringCount", "salesHiringCount",
    "churnSignalScore", "hiringTrend", "topRolesHiring",
    "interpretation", "scrapeSource", "scrapedAt",
];

function escapeCSV(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return escapeCSV(value.join("; "));
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function saveCompetitorCSV(data, outputFile) {
    try {
        const filePath   = path.resolve(__dirname, "..", "..", "data", outputFile);
        const fileExists = fs.existsSync(filePath);
        const header     = COMPETITOR_COLUMNS.join(",") + "\n";
        const rows = data.map(row =>
            COMPETITOR_COLUMNS.map(col => escapeCSV(row[col])).join(",")
        ).join("\n");

        if (!fileExists) {
            fs.writeFileSync(filePath, header + rows + "\n", "utf8");
        } else {
            fs.appendFileSync(filePath, rows + "\n", "utf8");
        }
        console.log(`[competitorMonitor] Saved → ${filePath}`);
    } catch (err) {
        console.warn("[competitorMonitor] CSV save error:", err.message);
    }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runCompetitorMonitor(config, browser) {
    const results = [];

    if (!config?.competitors?.length) {
        console.warn("[competitorMonitor] No competitors configured.");
        return results;
    }

    for (const competitor of config.competitors) {
        console.log(`[competitorMonitor] Analysing ${competitor.name}...`);
        let titles      = [];
        let scrapeSource = "Unknown";

        // Tier 1: LinkedIn
        try {
            await jitter(800, 2000);
            titles = await scrapeLinkedInJobs(competitor.linkedinSlug, browser);
            if (titles.length > 0) scrapeSource = "LinkedIn";
        } catch (err) {
            console.warn(`[competitorMonitor] LinkedIn failed for ${competitor.name}:`, err.message);
        }

        // Tier 2: Indeed fallback
        if (titles.length === 0) {
            try {
                await jitter(800, 2000);
                titles = await scrapeIndeedFallback(competitor.name, browser);
                if (titles.length > 0) scrapeSource = "Indeed";
            } catch (err) {
                console.warn(`[competitorMonitor] Indeed failed for ${competitor.name}:`, err.message);
            }
        }

        // Tier 3: Company site
        if (titles.length === 0 && competitor.website) {
            try {
                await jitter(600, 1400);
                titles = await scrapeCompanySite(competitor.website);
                if (titles.length > 0) scrapeSource = "CompanySite";
            } catch (err) {
                console.warn(`[competitorMonitor] Company site failed for ${competitor.name}:`, err.message);
            }
        }

        const intelligence = buildIntelligence(competitor, titles, scrapeSource);
        results.push(intelligence);
    }

    // Save to CSV
    if (results.length > 0 && config.outputFile) {
        saveCompetitorCSV(results, config.outputFile);
    }

    return results;
}
