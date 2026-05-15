// @ts-nocheck
// ─── LinkedIn Company Scraper ─────────────────────────────────────────────────
// Tier 1: Playwright → extracts real website + followers from LinkedIn /about
// Tier 2: DuckDuckGo Lite search → Google Search fallback

import https from "https";

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

export async function scrapeLinkedIn(companyName, browser = null) {
    const result = { url: "", website: "", followers: "", confidence: 0 };

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

    return result;
}

async function findLinkedInUrl(companyName) {
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
        const html  = await ddgGet(url, 10000);

        const matches = [...html.matchAll(/https:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_-]+)/g)];
        if (matches.length > 0) {
            const slug = matches[0][1].replace(/["'\\>]/g, "").split("/")[0];
            if (slug && slug.length > 1) return `https://www.linkedin.com/company/${slug}`;
        }
    } catch { /* ignore */ }
    return "";
}

function cleanUrl(raw = "") {
    try {
        const u = new URL(raw);
        return `https://${u.hostname}`;
    } catch {
        return "";
    }
}

export function ddgGet(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                "User-Agent": randomUA(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
            timeout: timeoutMs,
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                ddgGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }
            let data = "";
            res.setEncoding("utf8");
            res.on("data", c => { if (data.length < 300000) data += c; });
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
}

export { jitter, sleep };


