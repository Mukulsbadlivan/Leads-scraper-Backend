// @ts-nocheck
import { ddgGet, jitter } from "./linkedinScraper.ts";

/**
 * Searches Reddit for pain points, reviews, and issues related to a company.
 * @param {string} companyName 
 * @returns {Promise<string>} A summary of pain points or hiring signals from Reddit.
 */
export async function getRedditIntelligence(companyName) {
    const queries = [
        `site:reddit.com "${companyName}" review OR issues`,
        `site:reddit.com "${companyName}" hiring OR "working at"`,
        `site:reddit.com "${companyName}" complaints OR problems`
    ];

    let intelligence = [];

    for (const query of queries) {
        try {
            await jitter(500, 1500);
            const html = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
            
            // Extract snippets from DDG lite results
            const snippets = [...html.matchAll(/<td class="result-snippet">([\s\S]*?)<\/td>/g)]
                .map(m => m[1].replace(/<[^>]+>/g, " ").trim())
                .filter(s => s.length > 20)
                .slice(0, 3);

            intelligence.push(...snippets);
            if (intelligence.length >= 5) break;
        } catch (err) {
            console.error(`[RedditIntelligence] Error for query "${query}":`, err.message);
        }
    }

    if (intelligence.length === 0) return "No significant Reddit signals found.";

    // Return unique snippets joined together
    return [...new Set(intelligence)].join(" | ");
}

/**
 * Searches Reddit for postings in the target sector and tags discovered leads/companies.
 */
export async function scrapeReddit(page, query, locationObj, maxPages = 1) {
    const leads = [];
    const sector = locationObj.sector || "Technology";
    const searchQuery = `site:reddit.com "${sector}" "hiring" OR "jobs"`;
    console.log(`    🔍 Scraping Reddit via DDG: ${searchQuery}`);
    try {
        const html = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(searchQuery)}`);
        
        // Match DuckDuckGo search result links and titles
        // Formats are typically <a class="result-link" href="URL">Title</a>
        const matches = [...html.matchAll(/class="result-link"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
        
        for (const m of matches) {
            const url = m[1];
            const title = m[2].replace(/<[^>]+>/g, "").trim();
            
            // Deduce company name from title
            let companyName = "";
            const hiringIndex = title.toLowerCase().indexOf("hiring");
            if (hiringIndex > 0) {
                const prefix = title.substring(0, hiringIndex).trim();
                const words = prefix.split(/\s+/).filter(w => /^[A-Z]/.test(w));
                if (words.length > 0) {
                    companyName = words[words.length - 1];
                }
            }
            if (!companyName) {
                const match = title.match(/([A-Z][a-zA-Z0-9]+)\s+is\s+/);
                if (match) companyName = match[1];
            }
            
            // Clean bracketed content
            companyName = companyName.replace(/[\[\]]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").trim();
            
            // Filter out common generic words
            if (companyName && companyName.length > 2 && !["Hiring", "Job", "Reddit", "We", "Looking", "HiringNow"].includes(companyName)) {
                leads.push({
                    jobTitle: title.slice(0, 100),
                    companyName: companyName,
                    location: locationObj.city || locationObj.state || locationObj.country || "Remote",
                    salary: "",
                    jobLink: url,
                    source: "Reddit",
                });
            }
        }
        console.log(`      Reddit: Found ${leads.length} listings`);
    } catch (err) {
        console.error("    ⚠️ Reddit scrape error:", err.message);
    }
    return leads;
}


