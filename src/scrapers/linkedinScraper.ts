// @ts-nocheck
// ─── LinkedIn Company Scraper ─────────────────────────────────────────────────
// Tier 1: Playwright → extracts real website + followers from LinkedIn /about
// Tier 2: DuckDuckGo Lite search → Google Search fallback

import https from "https";
import pLimit from "p-limit";
import { perfStart, perfEnd } from "../utils/perf.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rotate User-Agents to reduce rate-limiting
const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function jitter(min = 500, max = 1500) { return sleep(min + Math.random() * (max - min)); }

export async function scrapeLinkedIn(companyName, browser = null, locationObj = {}) {
    const result = { url: "", website: "", followers: "", confidence: 0, companySlug: "", companyNumericId: "" };

    // Step 1: Find LinkedIn URL via DDG Lite (fast, no CAPTCHA)
    const linkedinUrl = await findLinkedInUrl(companyName);
    if (!linkedinUrl) return result;

    result.url        = linkedinUrl;
    result.confidence = 70; // search-based confidence

    // Step 2: If browser available, open /about and extract real data
    if (browser) {
        try {
            const page = await browser.newPage();
            await page.setExtraHTTPHeaders({
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            });

            // Intercept images/fonts to speed up
            await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", r => r.abort());

            await page.goto(`${linkedinUrl}/about`, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
            });

            await page.waitForTimeout(2000 + Math.random() * 1500);

            const pageUrl = page.url();

            // Detect login wall / authwall
            const isBlocked = pageUrl.includes("login") ||
                pageUrl.includes("authwall") ||
                pageUrl.includes("signup") ||
                pageUrl.includes("checkpoint");

            if (!isBlocked) {
                const data = await page.evaluate(() => {
                    // Website: look for the external link in the about section
                    const links = Array.from(document.querySelectorAll("a[href]"));
                    const websiteLink = links.find(a => {
                        const h = a.getAttribute("href") || "";
                        return h.startsWith("http") &&
                            !h.includes("linkedin.com") &&
                            !h.includes("google.com");
                    });

                    // Followers: look for text like "12,345 followers"
                    const allText = document.body.innerText || "";
                    const followersMatch = allText.match(/([\d,]+)\s+followers/i);

                    return {
                        website: websiteLink ? websiteLink.href : "",
                        followers: followersMatch ? followersMatch[1] : "",
                    };
                });

                if (data.website) {
                    result.website    = cleanUrl(data.website);
                    result.confidence = 90;
                } else {
                    result.confidence = 80; // page loaded but no website found
                }
                result.followers = data.followers;
            }

            await page.close();
        } catch {
            // Playwright failed — keep search-based URL + confidence 70
        }
    }

    // Step 3: Extract company slug and numeric ID
    if (result.url) {
        const idData = await extractCompanyLinkedInId(result.url);
        result.companySlug      = idData.slug;
        result.companyNumericId = idData.numericId;
    }

    return result;
}

async function findLinkedInUrl(companyName) {
    // Try Geekflare Google Search first
    try {
        const query = `${companyName} site:linkedin.com/company`;
        const results = await geekflareGoogleSearch(query);
        for (const res of results) {
            try {
                const u = new URL(res.url);
                const path = u.pathname.replace(/\/$/, "");
                const parts = path.split("/").filter(Boolean);
                if (parts.length === 2 && parts[0] === "company") {
                    return `https://www.linkedin.com/company/${parts[1]}`;
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }

    // Try DDG Lite first
    const ddgResult = await tryDDGLinkedIn(companyName);
    if (ddgResult) return ddgResult;

    // Fallback: Google search scrape
    await jitter(800, 2000);
    return await tryGoogleLinkedIn(companyName);
}

async function tryDDGLinkedIn(companyName) {
    try {
        await jitter(300, 900);
        const query = encodeURIComponent(`${companyName} site:linkedin.com/company`);
        const html  = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${query}`);

        // DDG Lite blocks with captcha page — detect it
        if (html.includes("unusual traffic") || html.includes("CAPTCHA") || html.length < 500) return "";

        const matches = [...html.matchAll(/href="(https?:\/\/[^"]*linkedin\.com\/company\/[^"?#]+)/g)];
        for (const m of matches) {
            try {
                const u    = new URL(m[1]);
                const path = u.pathname.replace(/\/$/, "");
                const parts = path.split("/").filter(Boolean);
                if (parts.length === 2 && parts[0] === "company") {
                    return `https://www.linkedin.com/company/${parts[1]}`;
                }
            } catch { /* skip */ }
        }
    } catch { /* ignore */ }
    return "";
}

async function tryGoogleLinkedIn(companyName) {
    try {
        // Use Google's public search — no API key needed, just parse href anchors
        const query = encodeURIComponent(`${companyName} linkedin company page`);
        const url   = `https://www.google.com/search?q=${query}&num=10`;
        const html  = await ddgGet(url, 4000);

        const matches = [...html.matchAll(/https:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_-]+)/g)];
        if (matches.length > 0) {
            const slug = matches[0][1].replace(/["'\\>]/g, "").split("/")[0];
            if (slug && slug.length > 1) return `https://www.linkedin.com/company/${slug}`;
        }
    } catch { /* ignore */ }
    return "";
}

// ─── LinkedIn Company ID Extractor ───────────────────────────────────────────

/**
 * Given a LinkedIn company URL like https://www.linkedin.com/company/yunojuno
 * returns:
 *   slug       - the URL slug (e.g. "yunojuno")
 *   numericId  - the internal company ID from LinkedIn's API (e.g. "2333371")
 *               Falls back to empty string if the API is unavailable.
 */
export async function extractCompanyLinkedInId(linkedinUrl = "") {
    const result = { slug: "", numericId: "" };
    if (!linkedinUrl) return result;

    // ── 1. Extract slug from URL ──────────────────────────────────────────────
    try {
        const u     = new URL(linkedinUrl);
        const parts = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
        // e.g. ["company", "yunojuno"] or ["company", "yunojuno", "about"]
        if (parts[0] === "company" && parts[1]) {
            result.slug = parts[1];
        }
    } catch { /* bad URL */ }

    if (!result.slug) return result;

    // ── 2. Fetch numeric ID from LinkedIn's public page HTML ──────────────────
    // LinkedIn embeds the numeric company ID in several JSON-LD / script tags.
    // No auth required for the public company page.
    try {
        const apiUrl = `https://www.linkedin.com/company/${encodeURIComponent(result.slug)}`;
        const html   = await ddgGet(apiUrl, 10000);

        // Try multiple patterns in order of reliability
        const patterns = [
            /"companyId"\s*:\s*(\d{4,12})/,           // JSON-LD "companyId"
            /urn:li:company:(\d{4,12})/,               // entity URN
            /"id"\s*:\s*(\d{5,12})/,                   // generic "id" field
            /\/company\/(\d{5,12})[^0-9]/,             // numeric slug in URL path
        ];
        for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
                result.numericId = m[1];
                break;
            }
        }
    } catch { /* non-fatal — keep slug only */ }

    return result;
}

function cleanUrl(raw = "") {
    try {
        const u = new URL(raw);
        return `https://${u.hostname}`;
    } catch {
        return "";
    }
}

export function ddgGet(url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        let req;
        const timer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            if (req) req.destroy();
            reject(new Error("timeout"));
        }, timeoutMs);

        req = https.get(url, {
            headers: {
                "User-Agent": randomUA(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
            timeout: timeoutMs,
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                clearTimeout(timer);
                ddgGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }
            let data = "";
            res.setEncoding("utf8");
            res.on("data", c => { if (data.length < 300000) data += c; });
            res.on("end", () => {
                if (isDone) return;
                isDone = true;
                clearTimeout(timer);
                resolve(data);
            });
        });
        req.on("error", (err) => {
            if (isDone) return;
            isDone = true;
            clearTimeout(timer);
            reject(err);
        });
        req.on("timeout", () => {
            if (isDone) return;
            isDone = true;
            clearTimeout(timer);
            req.destroy();
            reject(new Error("timeout"));
        });
    });
}

const geekflareLimit = pLimit(2);

export async function geekflareGoogleSearch(query) {
    const apiKey = process.env.GEEKFLARE_API_KEY || "";
    if (!apiKey) return [];

    return geekflareLimit(async () => {
        const t = perfStart("Geekflare");
        try {
            let retries = 3; // 3 retries (4 attempts total)
            let delayMs = 1200;
            
            while (retries >= 0) {
                const attempt = 4 - retries;
                const start = Date.now();
                console.log(`[Geekflare Request]`);
                console.log(`  endpoint = https://api.geekflare.com/search`);
                console.log(`  method   = POST`);
                console.log(`  query    = "${query}"`);
                console.log(`  headers  = { "Content-Type": "application/json", "x-api-key": "[REDACTED]" }`);
                console.log(`  timeout  = 8000ms`);
                console.log(`  attempt  = ${attempt}/4`);

                try {
                    const payload = JSON.stringify({
                        query: query,
                        country: "us"
                    });
                    
                    const { statusCode, body } = await new Promise<{ statusCode: number, body: string }>((resolve, reject) => {
                        const parsed = new URL("https://api.geekflare.com/search");
                        const options = {
                            hostname: parsed.hostname,
                            path: `${parsed.pathname}${parsed.search}`,
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Content-Length": Buffer.byteLength(payload),
                                "x-api-key": apiKey
                            },
                            timeout: 8000,
                        };
                        const req = https.request(options, (res) => {
                            let data = "";
                            res.setEncoding("utf8");
                            res.on("data", c => { if (data.length < 500000) data += c; });
                            res.on("end", () => {
                                resolve({ statusCode: res.statusCode || 0, body: data });
                            });
                        });
                        req.on("error", reject);
                        req.on("timeout", () => {
                            req.destroy();
                            reject(new Error("timeout"));
                        });
                        req.write(payload);
                        req.end();
                    });

                    const duration = Date.now() - start;
                    geekflareTotalDuration += duration;
                    geekflareRequestCount++;
                    const avg = (geekflareTotalDuration / geekflareRequestCount).toFixed(2);

                    console.log(`[Geekflare Response]`);
                    console.log(`  status   = ${statusCode}`);
                    console.log(`  duration = ${duration}ms`);
                    console.log(`  avgTime  = ${avg}ms`);
                    console.log(`  body     = ${body.substring(0, 500)}${body.length > 500 ? "..." : ""}`);

                    if (statusCode === 429) {
                        throw new Error("HTTP 429");
                    }
                    if (statusCode === 500) {
                        throw new Error("HTTP 500");
                    }
                    if (statusCode >= 200 && statusCode < 300) {
                        const data = JSON.parse(body);
                        if (Array.isArray(data.data)) {
                            return data.data.map(item => ({
                                title: item.title || "",
                                url: item.url || "",
                                snippet: item.snippet || ""
                            }));
                        }
                        return [];
                    }
                    throw new Error(`HTTP ${statusCode}`);

                } catch (err: any) {
                    const duration = Date.now() - start;
                    const isTimeout = err.message === "timeout";
                    const is500 = err.message === "HTTP 500";
                    const is429 = err.message === "HTTP 429";

                    console.log(`[Geekflare Response]`);
                    console.log(`  status   = ${isTimeout ? "timeout" : err.message}`);
                    console.log(`  duration = ${duration}ms`);

                    // Check if key is invalid / quota exhausted
                    if (err.message && (err.message.includes("402") || err.message.includes("401") || err.message.includes("403"))) {
                        process.stdout.write(`\n⚠️  [Geekflare Error] Received ${err.message}. Quota exhausted or key invalid. Switching to public DuckDuckGo/Google fallbacks...\n`);
                        delete process.env.GEEKFLARE_API_KEY;
                        break;
                    }

                    if (retries > 0) {
                        retries--;
                        let reason = "Error";
                        if (isTimeout) reason = "Timeout";
                        else if (is500) reason = "HTTP 500";
                        else if (is429) reason = "HTTP 429 Rate Limit";

                        process.stdout.write(`\n⚠️  [Geekflare ${reason} Warning] Retrying query "${query}" in ${delayMs}ms... (Remaining retries: ${retries})\n`);
                        await new Promise(r => setTimeout(r, delayMs));
                        delayMs *= 2;
                        continue;
                    } else {
                        process.stderr.write(`[Geekflare Search Error] query: ${query}, error: ${err.message}. All retries exhausted.\n`);
                        break;
                    }
                }
            }
            return [];
        } finally {
            perfEnd(t);
        }
    });
}

export { jitter, sleep };



