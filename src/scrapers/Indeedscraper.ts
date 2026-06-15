// @ts-nocheck
// ─── Indeed Scraper via RSS Feed ──────────────────────────────────────────────
// Uses Indeed's public RSS feed — no blocking, no CAPTCHA

import { getIndeedSubdomain, getLocationSearchString } from "../config/LocationConfig.ts";
export async function scrapeIndeed(page, query, locationObj, maxPages = 2) {
    const leads = [];

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        const start = pageNum * 25;
        
        const location = getLocationSearchString(locationObj.country, locationObj.state, locationObj.city);
        const subdomain = getIndeedSubdomain(locationObj.country);

        const rssUrl = `https://${subdomain}.indeed.com/rss?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}&start=${start}`;

        console.log(`    📄 Indeed RSS page ${pageNum + 1}`);

        try {
            const tNavStart = Date.now();
            try {
                await Promise.race([
                    page.goto(rssUrl, { waitUntil: "domcontentloaded", timeout: 30000 }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Indeed RSS page.goto timeout (30s)")), 30000)
                    )
                ]);
                const navDuration = Date.now() - tNavStart;
                console.log(`[PERF] [Indeed RSS] page.goto completed in ${navDuration}ms for URL: ${rssUrl}`);
            } catch (err) {
                const navDuration = Date.now() - tNavStart;
                console.error(`[PERF] [Indeed RSS] page.goto failed/timed out in ${navDuration}ms for URL: ${rssUrl}. Error: ${err.message}`);
                throw err;
            }
            await page.waitForTimeout(2000);

            const content = await page.content();

            // Parse RSS XML
            const items = content.match(/<item>([\s\S]*?)<\/item>/g) || [];
            console.log(`      Found ${items.length} RSS items`);

            for (const item of items) {
                const title = stripTags(extractTag(item, "title"));
                const link = extractTag(item, "link") || extractTag(item, "guid") || "";
                const desc = stripTags(extractTag(item, "description") || "");
                const pubDate = extractTag(item, "pubDate") || "";

                // Extract company name from title (format: "Job Title - Company Name - Location")
                const parts = title.split(" - ");
                const jobTitle = parts[0]?.trim() || "";
                const companyName = parts[1]?.trim() || "";
                const location2 = parts[2]?.trim() || location;

                // Try to extract salary from description
                const salaryMatch = desc.match(/\$[\d,]+|\₹[\d,]+|[\d,]+ per (hour|year|month|annum)/i);
                const salary = salaryMatch ? salaryMatch[0] : "";

                if (companyName && jobTitle) {
                    leads.push({
                        jobTitle,
                        companyName,
                        location: location2,
                        salary,
                        jobLink: link.trim(),
                        source: "Indeed",
                    });
                }
            }

            await page.waitForTimeout(1500);
        } catch (err) {
            console.error(`    ⚠️ Indeed RSS page ${pageNum + 1} error:`, err.message);
        }
    }

    return leads;
}

function extractTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"));
    return match ? match[1].trim() : "";
}

function stripTags(str) {
    return str
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

