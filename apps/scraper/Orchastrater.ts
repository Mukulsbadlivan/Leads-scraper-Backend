// @ts-nocheck
import "dotenv/config";
import { chromium } from "playwright";
import { scrapeIndeed } from "./Indeedscraper.ts";
import { scrapeGlassdoor } from "./glassdoorscraper.ts";
import { scrapeUpwork } from "./upworkScraper.ts";
import { enrichLead } from "./leadenricher.ts";
import { scoreICP } from "./icpscorer.ts";
import { detectIntents } from "./intentDetector.ts";
import { saveResults, appendLeadToCSV } from "./saveresult.ts";

// ─── CONFIG — Edit these to change what gets scraped ──────────────────────────
const CONFIG = {
    // Multiple search queries to cover different angles
    searchQueries: [
        "Software Engineer",
        "Data Engineer",
        "Healthcare",
        "Marketing",
    ],
    // Locations to target
    locations: ["USA"],
    maxPages: 3, // Increased for better coverage
    portals: ["indeed", "glassdoor", "upwork"],
    outputFile: "job_leads_live.csv",
    headless: true,
    filters: {
        sectors: ["Technology", "Finance & Fintech", "Healthcare", "E-Commerce"],
        regions: ["USA"],
        fundingStages: ["Series A", "Series B", "Series C", "IPO/Public"],
        minEmployeeCount: 10,
        maxEmployeeCount: 500,
        requirePhone: false,
        requireLinkedIn: true,
        minLinkedInConfidence: 60,
        minEmailConfidence: 60,
        b2bSaaSOnly: false,
        requiredRoles: [
            "Data Engineer", "Software Engineer", "Brand Manager", "Marketing Analytics Manager", "Head of Engineering", "Data Scientist"
        ],
        requireRecentFunding: false,
        requireCtoLinkedInActive: false,
        // Combined Tech, Finance, and Healthcare keywords
        requiredTechKeywords: [
            "Python", "AWS", "React", "Node.js", "Kubernetes", "TypeScript",
            // Finance keywords
            "Fintech", "Banking", "Compliance", "PCI-DSS", "Blockchain",
            // Healthcare keywords
            "Healthtech", "HIPAA", "EHR", "Clinical", "FHIR"
        ],
    },
    fallbackToUnfilteredOnEmpty: true,

    // ── Competitor Monitoring ──────────────────────────────────────────────────
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


// ─── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log("\n🚀 ICP Lead Intelligence Scraper Starting...");
    console.log("📋 Config:", CONFIG);

    const browser = await chromium.launch({
        headless: CONFIG.headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
    });

    let allRawLeads = [];

    try {
        for (const portal of CONFIG.portals) {
            for (const query of CONFIG.searchQueries) {
                for (const loc of CONFIG.locations) {
                    const page = await context.newPage();
                    console.log(`\n🔍 Scraping ${portal.toUpperCase()} | 🔎 "${query}" in ${loc}...`);

                    try {
                        let leads = [];
                        if (portal === "indeed") {
                            leads = await scrapeIndeed(page, query, loc, CONFIG.maxPages);
                        } else if (portal === "glassdoor") {
                            leads = await scrapeGlassdoor(page, query, loc, CONFIG.maxPages);
                        } else if (portal === "upwork") {
                            leads = await scrapeUpwork(page, query, loc, CONFIG.maxPages);
                        }
                        console.log(`  ✅ Found ${leads.length} raw leads`);
                        allRawLeads.push(...leads);
                    } catch (err) {
                        console.error(`  ❌ Error scraping ${portal} for "${query}":`, err.message);
                    }

                    await page.close();
                }
            }
        }

        // ── If still 0, add fallback sample data so CSV is never empty ──
        if (allRawLeads.length === 0) {
            console.log("\n⚠️  All portals returned 0 results (likely blocked).");
            console.log("   Adding fallback sample leads so CSV is not empty...\n");
            allRawLeads = getFallbackLeads(CONFIG.searchQueries[0], CONFIG.locations[0]);
        }

        const uniqueLeads = buildCompanyLeads(allRawLeads);
        console.log(`🔄 Deduped to ${uniqueLeads.length} unique companies`);

        // Enrich + Score  (share one browser across all leads — much faster)
        console.log("\n⚙️  Enriching and scoring leads...");
        const enrichBrowser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
        });

        const enrichedLeads = [];

        // Handle Ctrl+C gracefully
        process.on("SIGINT", () => {
            console.log("\n🛑 Interrupted! Exiting safely...");
            process.exit();
        });

        for (let i = 0; i < uniqueLeads.length; i++) {
            const lead = uniqueLeads[i];
            process.stdout.write(`  [${i + 1}/${uniqueLeads.length}] ${lead.companyName}...`);
            try {
                const enriched = await enrichLead(lead, { browser: enrichBrowser });
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

                // Real-time save: append each lead as it's finished
                await appendLeadToCSV(scored, CONFIG.outputFile);


            } catch (err) {
                process.stdout.write(` ⚠️ skipped — ${err.message}\n`);
                enrichedLeads.push({ ...lead, icpScore: 0, icpTier: "Cold", scrapeTimestamp: new Date().toISOString() });
            }
        }

        await enrichBrowser.close();

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

        const outputPath = await saveResults(finalLeads, CONFIG.outputFile);
        console.log(`\n✅ Done! ${finalLeads.length} leads saved to:\n   ${outputPath}`);
        if (finalLeads[0]) {
            console.log(`🏆 Top lead: ${finalLeads[0].companyName} (Score: ${finalLeads[0].icpScore})`);
        }

        // ── Competitor Intelligence ─────────────────────────────────────────────
        if (CONFIG.competitorMonitoring.enabled) {
            console.log("\n🕵️  Running Competitor Job Posting Monitor...");
            try {
                const { runCompetitorMonitor } = await import("./competitorMonitor.ts");
                const competitorData = await runCompetitorMonitor(CONFIG.competitorMonitoring, browser);
                console.log(`✅ Competitor monitor done. ${competitorData.length} competitors analysed.`);
                competitorData.forEach(c => {
                    console.log(`   📊 ${c.competitorName}: ${c.totalOpenRoles} roles | ChurnScore: ${c.churnSignalScore}/100 | ${c.interpretation}`);
                });
            } catch (err) {
                console.error("  ⚠️ Competitor monitor failed:", err.message);
            }
        }

    } catch (err) {
        console.error("\n💥 Fatal error:", err);
    } finally {
        await browser.close();
    }
})();

// ─── Fallback leads (used when portals are blocked) ───────────────────────────
function getFallbackLeads(query, location) {
    return [
        { jobTitle: "Senior Software Engineer", companyName: "Infosys", location: "Bengaluru, India", salary: "₹15-25 LPA", jobLink: "https://infosys.com/careers", source: "Fallback" },
        { jobTitle: "Full Stack Developer", companyName: "TCS", location: "Mumbai, India", salary: "₹12-20 LPA", jobLink: "https://tcs.com/careers", source: "Fallback" },
        { jobTitle: "Lead Engineer", companyName: "Wipro", location: "Hyderabad, India", salary: "₹14-22 LPA", jobLink: "https://wipro.com/careers", source: "Fallback" },
        { jobTitle: "Software Developer", companyName: "HCL Technologies", location: "Noida, India", salary: "₹10-18 LPA", jobLink: "https://hcltech.com/careers", source: "Fallback" },
        { jobTitle: "Backend Engineer", companyName: "Razorpay", location: "Bengaluru, India", salary: "₹20-35 LPA", jobLink: "https://razorpay.com/jobs", source: "Fallback" },
        { jobTitle: "Frontend Developer", companyName: "Zomato", location: "Gurugram, India", salary: "₹18-30 LPA", jobLink: "https://zomato.com/careers", source: "Fallback" },
        { jobTitle: "Data Engineer", companyName: "Flipkart", location: "Bengaluru, India", salary: "₹22-38 LPA", jobLink: "https://flipkartcareers.com", source: "Fallback" },
        { jobTitle: "DevOps Engineer", companyName: "Paytm", location: "Noida, India", salary: "₹16-28 LPA", jobLink: "https://paytm.com/careers", source: "Fallback" },
        { jobTitle: "ML Engineer", companyName: "Swiggy", location: "Bengaluru, India", salary: "₹25-40 LPA", jobLink: "https://careers.swiggy.com", source: "Fallback" },
        { jobTitle: "Cloud Architect", companyName: "Tech Mahindra", location: "Pune, India", salary: "₹20-35 LPA", jobLink: "https://techmahindra.com/careers", source: "Fallback" },
        { jobTitle: "Software Engineer", companyName: "CRED", location: "Bengaluru, India", salary: "₹25-45 LPA", jobLink: "https://cred.club/careers", source: "Fallback" },
        { jobTitle: "Senior Developer", companyName: "PhonePe", location: "Bengaluru, India", salary: "₹22-38 LPA", jobLink: "https://phonepe.com/en/careers.html", source: "Fallback" },
        { jobTitle: "Platform Engineer", companyName: "Meesho", location: "Bengaluru, India", salary: "₹20-32 LPA", jobLink: "https://meesho.io/careers", source: "Fallback" },
        { jobTitle: "Full Stack Engineer", companyName: "OYO", location: "Gurugram, India", salary: "₹15-25 LPA", jobLink: "https://careers.oyorooms.com", source: "Fallback" },
        { jobTitle: "Senior Software Developer", companyName: "Freshworks", location: "Chennai, India", salary: "₹18-30 LPA", jobLink: "https://careers.freshworks.com", source: "Fallback" },
        { jobTitle: "Backend Developer", companyName: "Zepto", location: "Mumbai, India", salary: "₹20-35 LPA", jobLink: "https://www.zepto.com/careers", source: "Fallback" },
        { jobTitle: "Software Engineer II", companyName: "Dream11", location: "Mumbai, India", salary: "₹25-40 LPA", jobLink: "https://dream11.com/careers", source: "Fallback" },
        { jobTitle: "Lead Software Engineer", companyName: "Dunzo", location: "Bengaluru, India", salary: "₹18-28 LPA", jobLink: "https://dunzo.com/careers", source: "Fallback" },
        { jobTitle: "Principal Engineer", companyName: "Byju's", location: "Bengaluru, India", salary: "₹30-50 LPA", jobLink: "https://byjus.com/careers", source: "Fallback" },
        { jobTitle: "Software Development Engineer", companyName: "Amazon India", location: "Hyderabad, India", salary: "₹35-60 LPA", jobLink: "https://amazon.jobs", source: "Fallback" },
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
            hiringVelocity: {
                last30days,
                last60days,
                trend,
                topRoles,
            },
            hiringTopRoles: topRoles,
        });
    }

    return companyLeads;
}

