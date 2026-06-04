// @ts-nocheck
// ─── Website Finder ───────────────────────────────────────────────────────────
// Tier 1: Extracted from LinkedIn Playwright scrape (passed in)
// Tier 2: DuckDuckGo Lite search
// Tier 3: Domain candidate guessing + HEAD validation

import { ddgGet, jitter, geekflareGoogleSearch } from "../scrapers/linkedinScraper.ts";
import https from "https";
import { isDomainAlive } from "./validation.ts";



const EXCLUDED_DOMAINS = [
    "linkedin.com", "crunchbase.com", "glassdoor.com", "indeed.com",
    "bloomberg.com", "zoominfo.com", "owler.com", "dnb.com",
    "wikipedia.org", "twitter.com", "x.com", "facebook.com", "instagram.com",
    "youtube.com", "angel.co", "wellfound.com", "pitchbook.com",
    "ambitionbox.com", "comparably.com", "craft.co", "apollo.io",
    "rocketreach.co", "clearbit.com", "g2.com", "trustpilot.com",
    "duckduckgo.com", "naukri.com", "shine.com", "monster.com",
];

/**
 * @param {string} companyName
 * @param {string} [linkedinWebsite]  - pre-extracted from LinkedIn Playwright scrape
 * @returns {Promise<{url: string, confidence: number}>}
 */
export async function findWebsite(companyName, linkedinWebsite = "") {
    // Tier 1: Trust LinkedIn-sourced website (Playwright got it)
    if (linkedinWebsite) {
        const clean = normalizeUrl(linkedinWebsite);
        if (clean && !isDomainExcluded(clean)) {
            return { url: clean, confidence: 90 };
        }
    }

    // Tier 1.5: Geekflare Google Search
    try {
        const query = `${companyName} official website`;
        const results = await geekflareGoogleSearch(query);
        for (const res of results) {
            const clean = normalizeUrl(res.url);
            if (!clean) continue;
            if (isDomainExcluded(clean)) continue;

            try {
                const host     = new URL(clean).hostname.replace(/^www\./, "");
                const slug     = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
                const hostSlug = host.replace(/\..+$/, "").replace(/[^a-z0-9]/g, "");
                const confidence = (hostSlug.includes(slug) || slug.includes(hostSlug)) ? 80 : 55;
                return { url: clean, confidence };
            } catch { /* skip */ }
        }
    } catch { /* ignore */ }

    // If Geekflare is enabled, skip the slow/blocked DDG/website fallbacks
    if (process.env.GEEKFLARE_API_KEY) {
        const slug  = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
        return { url: `https://${slug}.com`, confidence: 20 };
    }

    try {
        await jitter(400, 1200);
        const query = encodeURIComponent(`${companyName} official website`);
        const html  = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${query}`);
        if (html.includes("unusual traffic") || html.includes("CAPTCHA") || html.length < 500) throw new Error("DDG blocked");
        const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]);

        for (const href of hrefs) {
            const clean = normalizeUrl(href);
            if (!clean) continue;
            if (isDomainExcluded(clean)) continue;

            try {
                const host     = new URL(clean).hostname.replace(/^www\./, "");
                const slug     = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
                const hostSlug = host.replace(/\..+$/, "").replace(/[^a-z0-9]/g, "");
                const confidence = (hostSlug.includes(slug) || slug.includes(hostSlug)) ? 80 : 55;
                return { url: clean, confidence };
            } catch { /* skip */ }
        }
    } catch { /* ignore */ }

    // Tier 3: Domain guessing + HEAD validation
    const slug  = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const tlds  = [".com", ".in", ".co", ".io", ".ai", ".net", ".org"];
    for (const tld of tlds) {
        const candidate = `https://${slug}${tld}`;
        if (!await isDomainAlive(candidate)) continue;
        const alive = await headCheck(candidate);
        if (alive) return { url: candidate, confidence: 45 };
    }

    // Final fallback: just return the .com guess even without validation
    return { url: `https://${slug}.com`, confidence: 20 };
}

function normalizeUrl(raw = "") {
    try {
        const u = new URL(raw);
        return `https://${u.hostname}`;
    } catch { return ""; }
}

function isDomainExcluded(url = "") {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return EXCLUDED_DOMAINS.some(ex => host.includes(ex));
    } catch { return true; }
}

function headCheck(url, timeoutMs = 4000) {
    return new Promise(resolve => {
        try {
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                path: "/",
                method: "HEAD",
                timeout: timeoutMs,
                headers: { "User-Agent": "Mozilla/5.0" },
            };
            const req = https.request(options, res => {
                resolve(res.statusCode >= 200 && res.statusCode < 400);
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.end();
        } catch { resolve(false); }
    });
}


