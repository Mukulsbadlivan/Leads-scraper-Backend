// @ts-nocheck
/**
 * Upwork Scraper via RSS Feed
 * Extracts job postings from Upwork's RSS feed.
 */

export async function scrapeUpwork(page, query, locationObj, maxPages = 1) {
    const leads = [];
    
    const baseUrl = process.env.UPWORK_RSS_URL || `https://www.upwork.com/ab/feed/jobs/rss`;
    const rssUrl = baseUrl.includes('?') 
        ? `${baseUrl}&q=${encodeURIComponent(query)}` 
        : `${baseUrl}?q=${encodeURIComponent(query)}`;

    console.log(`    📄 Upwork RSS feed: ${rssUrl}`);

    try {
        await page.goto(rssUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
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

            // Upwork RSS title is just the job title.
            // Client/Company name is often NOT in the RSS feed directly.
            // We might need to mark it as "Upwork Client" or try to find it in the description.
            
            let companyName = "Upwork Client";
            const clientMatch = desc.match(/Client Name:\s*([^\n<]+)/i);
            if (clientMatch) companyName = clientMatch[1].trim();

            // Extract client country from description
            const countryMatch = desc.match(/<b>Country<\/b>:\s*([^\n<]+)/i) || desc.match(/Country:\s*([^\n<]+)/i);
            const clientCountry = countryMatch ? countryMatch[1].trim() : "";

            // Filter by selected country if not in Remote mode
            if (locationObj && locationObj.country && locationObj.country.toLowerCase() !== "remote") {
                if (clientCountry && clientCountry.toLowerCase() !== locationObj.country.toLowerCase()) {
                    continue;
                }
            }

            // Extract budget/salary
            const budgetMatch = desc.match(/Budget:\s*([^\n<]+)/i) || desc.match(/Hourly Range:\s*([^\n<]+)/i);
            const salary = budgetMatch ? budgetMatch[1].trim() : "";

            if (title) {
                leads.push({
                    jobTitle: title,
                    companyName: companyName,
                    location: clientCountry ? `${clientCountry} (Upwork)` : "Remote (Upwork)",
                    salary,
                    jobLink: link.trim(),
                    jobDescription: desc,
                    source: "Upwork",
                });
            }
        }
    } catch (err) {
        console.error(`    ⚠️ Upwork RSS error:`, err.message);
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
